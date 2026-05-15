const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const Matter  = require('matter-js');
const { Engine, World, Bodies, Body } = Matter;

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

const WORLD_W    = 800;
const TRACK_H    = 7000;
const FINISH_Y   = TRACK_H - 200;
const R          = 22;
const TICK_MS    = 1000 / 60;
const EMIT_EVERY = 2;

let gameState = {
  phase: 'setup', marbles: [], round: 1,
  scores: {}, trackBodies: [], currentLeader: null, seed: null
};

let engine       = null;
let marbleBodies = [];
let physicsLoop  = null;
let tickCount    = 0;
let raceFinished = false;

function broadcastState() {
  const { phase, marbles, round, scores, currentLeader, seed } = gameState;
  io.emit('stateUpdate', { phase, marbles, round, scores, currentLeader, seed });
}

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function buildTrack(rand) {
  const bodies = [];

  const WALL_W = 15;
  const wallL = Bodies.rectangle(WALL_W / 2,           TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const wallR = Bodies.rectangle(WORLD_W - WALL_W / 2, TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const floor = Bodies.rectangle(WORLD_W / 2, TRACK_H + 10, WORLD_W, 20,   { isStatic: true, label: 'floor' });

  wallL._rw = WALL_W;  wallL._rh = TRACK_H;
  wallR._rw = WALL_W;  wallR._rh = TRACK_H;
  floor._rw = WORLD_W; floor._rh = 20;

  bodies.push(wallL, wallR, floor);

  // ─── RAMPAS PRINCIPALES (estilo zigzag amplio) ──────────────────────
  // 30 rampas espaciadas ~220px. Cada rampa se solapa en X con la
  // siguiente para que la canica siempre caiga sobre una superficie.
  const RAMP_COUNT = 30;
  const GAP        = TRACK_H / (RAMP_COUNT + 1);
  const MIN_GAP    = R * 2.5 + 6; // ~61px mínimo libre
  const CORRIDOR   = WORLD_W - WALL_W * 2; // 770px útil

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y     = GAP * (i + 1);
    const side  = i % 2 === 0 ? 'left' : 'right';
    const rw    = 140 + rand() * 160;           // 140-300px
    const deg   = 4 + rand() * 10;              // 4-14 grados
    const angle = deg * (Math.PI / 180) * (side === 'left' ? 1 : -1);

    // La rampa arranca pegada a su pared y apunta hacia el centro
    const margin = WALL_W + 5;                    // 20px desde el borde
    const x = side === 'left'
      ? margin + rw / 2
      : WORLD_W - margin - rw / 2;

    const ramp = Bodies.rectangle(x, y, rw, 10, {
      isStatic: true, angle, label: 'ramp', friction: 0.03, restitution: 0.35
    });
    ramp._rw = rw; ramp._rh = 10;
    bodies.push(ramp);

    // Bumper al final de la rampa (desvía hacia el centro)
    const bumpDir = side === 'left' ? 1 : -1;
    const bumpX = x + bumpDir * (rw / 2 + 18 + rand() * 20);
    const bumpR = 10 + rand() * 10;
    const bump = Bodies.circle(bumpX, y + 20 + rand() * 15, bumpR, {
      isStatic: true, label: 'bumper', restitution: 0.75, friction: 0
    });
    bump._radius = bumpR;
    bodies.push(bump);

    // Bumper pequeño en la pared opuesta (rebote)
    const oppX = side === 'left' ? WORLD_W - margin - 10 : margin + 10;
    const oppBump = Bodies.circle(oppX, y - 30 + rand() * 40, 8 + rand() * 6, {
      isStatic: true, label: 'bumper', restitution: 0.8, friction: 0
    });
    oppBump._radius = oppBump.circleRadius;
    bodies.push(oppBump);
  }

  // ─── ZONA DE OBSTÁCULOS (estilo paintball) ─────────────────────────
  // Obstáculos redondos dispersos con separación ≥ 60px.
  // Cada grupo tiene 2-4 bumpers formando una "barrera" que obliga a
  // las canicas a rodearlos, pero sin cerrar el paso.
  const obsStartY = GAP * 3;
  const obsEndY   = GAP * 27;

  for (let row = 0; row < 18; row++) {
    const y = obsStartY + (obsEndY - obsStartY) * (row / 17);
    const count = 2 + Math.floor(rand() * 2); // 2-3 por fila (más espacios)
    const spacing = CORRIDOR / (count + 1);
    const offsetX = (rand() - 0.5) * spacing * 0.4;

    for (let c = 0; c < count; c++) {
      const centerX = spacing * (c + 1) + offsetX + (rand() - 0.5) * 20;
      const cx = Math.max(WALL_W + 25, Math.min(WORLD_W - WALL_W - 25, centerX));
      const rObs = 12 + rand() * 9; // 12-21px

      // Verificar que no se solape con ningún otro obstáculo
      const tooClose = bodies.some(b => {
        if (!b.circleRadius) return false;
        const dx = b.position.x - cx;
        const dy = b.position.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        return dist < (b.circleRadius + rObs + MIN_GAP);
      });

      if (tooClose) continue;

      const obs = Bodies.circle(cx, y, rObs, {
        isStatic: true, label: 'bumper', restitution: 0.65 + rand() * 0.2, friction: 0
      });
      obs._radius = rObs;
      bodies.push(obs);
    }
  }

  // ─── DEFLECTOR CENTRAL (cada ~1000px, redirige al centro) ──────────
  const deflectorYs = [1200, 2200, 3200, 4200, 5200, 6200];
  deflectorYs.forEach(y => {
    const dSide = rand() > 0.5 ? 1 : -1;
    const dx = WORLD_W / 2 + dSide * (100 + rand() * 80);
    const dw = 140 + rand() * 60;
    const dh = 10;
    const dAngle = dSide * (0.15 + rand() * 0.2);
    const def = Bodies.rectangle(dx, y, dw, dh, {
      isStatic: true, angle: dAngle, label: 'ramp', friction: 0.02, restitution: 0.4
    });
    def._rw = dw; def._rh = dh;
    bodies.push(def);

    // Bumper a cada lado del deflector
    [-1, 1].forEach(s => {
      const bx = dx + s * (dw / 2 + 25);
      const br = 12 + rand() * 8;
      const bb = Bodies.circle(bx, y + 15, br, {
        isStatic: true, label: 'bumper', restitution: 0.7, friction: 0
      });
      bb._radius = br;
      bodies.push(bb);
    });
  });

  // ─── ZONA RÁPIDA (tramo abierto con pendiente) ─────────────────────
  const fastY = TRACK_H * 0.7;
  const fastRamp = Bodies.rectangle(WORLD_W / 2, fastY, 550, 12, {
    isStatic: true, angle: 0.18, label: 'ramp_fast', friction: 0.005, restitution: 0.3
  });
  fastRamp._rw = 550; fastRamp._rh = 12;
  bodies.push(fastRamp);

  // Bumpers anchos y separados en la zona rápida
  for (let j = 0; j < 5; j++) {
    const bx = 80 + rand() * (WORLD_W - 160);
    const by = fastY + 100 + rand() * 200;
    const br = 18 + rand() * 12;
    const bb = Bodies.circle(bx, by, br, {
      isStatic: true, label: 'bumper', restitution: 0.8 + rand() * 0.15, friction: 0
    });
    bb._radius = br;
    bodies.push(bb);
  }

  // ─── PRE-META (embudo suave y abierto) ─────────────────────────────
  const pmY = FINISH_Y - 400;
  const fL = Bodies.rectangle(180, pmY, 300, 12, {
    isStatic: true, angle: 0.45, label: 'wall', friction: 0.01, restitution: 0.4
  });
  fL._rw = 300; fL._rh = 12;
  const fR = Bodies.rectangle(620, pmY, 300, 12, {
    isStatic: true, angle: -0.45, label: 'wall', friction: 0.01, restitution: 0.4
  });
  fR._rw = 300; fR._rh = 12;
  bodies.push(fL, fR);

  // Bumpers dorados guía (no bloquean)
  const goldenYs = [pmY + 60, pmY + 140, pmY + 220];
  goldenYs.forEach((gy, gi) => {
    const spread = 80 + gi * 20;
    [WORLD_W / 2 - spread, WORLD_W / 2, WORLD_W / 2 + spread].forEach(gx => {
      const gb = Bodies.circle(gx, gy, 16, {
        isStatic: true, label: 'bumper_finish', restitution: 0.8, friction: 0
      });
      gb._radius = 16;
      bodies.push(gb);
    });
  });

  return bodies;
}

function serializeBody(b) {
  return {
    label:  b.label,
    x:      b.position.x,
    y:      b.position.y,
    angle:  b.angle,
    rw:     b._rw    !== undefined ? b._rw    : null,
    rh:     b._rh    !== undefined ? b._rh    : null,
    radius: b._radius !== undefined ? b._radius : (b.circleRadius || null)
  };
}

function startPhysics() {
  destroyRace();
  raceFinished = false;
  tickCount    = 0;

  engine = Engine.create();
  engine.gravity.y = 0.9;

  const rand        = seededRandom(gameState.seed);
  const trackBodies = buildTrack(rand);
  World.add(engine.world, trackBodies);

  gameState.trackBodies = trackBodies.map(serializeBody);

  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const body = Bodies.circle(startX, 60, R, {
      restitution: 0.5, friction: 0.005, frictionAir: 0.0006, label: 'marble_' + m.id
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 2, y: 4 });
    World.add(engine.world, body);
    marbleBodies.push({ id: m.id, body });
  });

  physicsLoop = setInterval(() => {
    Engine.update(engine, TICK_MS);
    tickCount++;

    if (tickCount % EMIT_EVERY !== 0) return;

    const positions = marbleBodies.map(({ id, body }) => ({
      id, x: body.position.x, y: body.position.y, angle: body.angle
    }));
    io.emit('positions', positions);

    if (marbleBodies.length) {
      const leader = marbleBodies.reduce((a, b) =>
        a.body.position.y > b.body.position.y ? a : b
      );
      if (leader.id !== gameState.currentLeader) {
        gameState.currentLeader = leader.id;
        io.emit('leaderChange', leader.id);
      }
    }

    if (!raceFinished) {
      for (const { id, body } of marbleBodies) {
        if (body.position.y >= FINISH_Y) {
          raceFinished = true;
          endRace(id);
          break;
        }
      }
    }
  }, TICK_MS);
}

function endRace(winnerId) {
  clearInterval(physicsLoop);
  physicsLoop = null;

  const sorted = [...marbleBodies].sort((a, b) => b.body.position.y - a.body.position.y);
  sorted.forEach((entry, i) => {
    if (!gameState.scores[entry.id]) gameState.scores[entry.id] = 0;
    if (i === 0) gameState.scores[entry.id] += 3;
    else if (i === 1) gameState.scores[entry.id] += 1;
  });

  gameState.phase = 'results';
  gameState.currentLeader = winnerId;
  broadcastState();
  io.emit('raceWinner', { winnerId, scores: gameState.scores });
  setTimeout(() => destroyRace(), 3000);
}

function destroyRace() {
  clearInterval(physicsLoop);
  physicsLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); }
  engine = null;
  marbleBodies = [];
}

io.on('connection', socket => {
  console.log('Conectado:', socket.id);

  socket.emit('stateUpdate', {
    phase: gameState.phase, marbles: gameState.marbles, round: gameState.round,
    scores: gameState.scores, currentLeader: gameState.currentLeader, seed: gameState.seed
  });

  if ((gameState.phase === 'racing' || gameState.phase === 'results') && gameState.trackBodies.length) {
    socket.emit('trackData', gameState.trackBodies);
  }

  socket.on('setMarbles', marbles => {
    gameState.marbles = marbles.map(m => ({
      id: m.id,
      name: m.name,
      color: m.color,
      image: m.image || null,
      sound: m.sound || null,
      soundName: m.soundName || ''
    }));
    marbles.forEach(m => { if (gameState.scores[m.id] === undefined) gameState.scores[m.id] = 0; });
    broadcastState();
  });

  socket.on('setPhase', phase => { gameState.phase = phase; broadcastState(); });

  socket.on('startRace', () => {
    if (!gameState.marbles.length) return;
    gameState.phase = 'racing';
    gameState.seed  = Date.now();
    startPhysics();
    broadcastState();
    io.emit('trackData', gameState.trackBodies);
  });

  socket.on('nextRound', () => {
    destroyRace();
    gameState.round++;
    gameState.phase = 'ready';
    gameState.currentLeader = null;
    gameState.trackBodies = [];
    broadcastState();
  });

  socket.on('resetRace', () => {
    destroyRace();
    gameState.phase = 'ready';
    gameState.currentLeader = null;
    gameState.trackBodies = [];
    broadcastState();
    io.emit('raceReset');
  });

  socket.on('resetGame', () => {
    destroyRace();
    gameState = { phase: 'setup', marbles: [], round: 1, scores: {}, trackBodies: [], currentLeader: null, seed: null };
    broadcastState();
  });

  socket.on('disconnect', () => console.log('Desconectado:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
