const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const Matter  = require('matter-js');
const { Engine, World, Bodies, Body, Constraint } = Matter;

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

const FAN_TOP = 2700;
const FAN_BOT = 4800;
const FAN_STR = 0.0005;

let gameState = {
  phase: 'setup', marbles: [], round: 1,
  scores: {}, trackBodies: [], currentLeader: null, seed: null
};

let engine         = null;
let marbleBodies   = [];
let physicsLoop    = null;
let tickCount      = 0;
let raceFinished   = false;
let spinnerBars    = [];
let pendulumBars   = [];

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
  spinnerBars  = [];
  pendulumBars = [];

  const WALL_W = 15;
  const wallL = Bodies.rectangle(WALL_W / 2, TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const wallR = Bodies.rectangle(WORLD_W - WALL_W / 2, TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const floor = Bodies.rectangle(WORLD_W / 2, TRACK_H + 10, WORLD_W, 20, { isStatic: true, label: 'floor' });
  wallL._rw = WALL_W;  wallL._rh = TRACK_H;
  wallR._rw = WALL_W;  wallR._rh = TRACK_H;
  floor._rw = WORLD_W; floor._rh = 20;
  bodies.push(wallL, wallR, floor);

  const W = WORLD_W - WALL_W * 2; // 770px útiles

  // ═══════════════════════════════════════════════════════════════════
  // ZONA 1: PLINKO  (y: 120 ~ 2600, filas 0-29)
  // Triángulo: 9 bolas filas pares, 8 impares.  S=90, bolas 15-20px.
  // Gap mínimo: 90-40=50px > 44 (canica) → SIEMPRE cabe.
  // ═══════════════════════════════════════════════════════════════════
  const S     = 90;
  const PSTART = (W - S * 8) / 2 + WALL_W; // centrado

  for (let row = 0; row < 30; row++) {
    const y      = 120 + row * 82;
    const isEven = row % 2 === 0;
    const off    = isEven ? 0 : S / 2;
    const count  = isEven ? 9 : 8;

    for (let col = 0; col < count; col++) {
      const x  = PSTART + off + col * S;
      const pr = 15 + rand() * 5;
      const boost = rand() < 0.12;
      const peg   = Bodies.circle(x, y, pr, {
        isStatic: true, label: 'bumper',
        restitution: boost ? 0.92 : 0.55 + rand() * 0.25,
        friction: 0
      });
      peg._radius = pr;
      bodies.push(peg);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ZONA 2: PÉNDULOS + VENTILADOR  (y: 2600 ~ 4100, filas 30-49)
  // Filas pares: 2 bolas grandes separadas (>80px entre ellas)
  // Filas impares: barras PÉNDULO que oscilan lentamente
  // El ventilador aplica fuerza horizontal en toda esta zona.
  // ═══════════════════════════════════════════════════════════════════
  for (let row = 30; row < 50; row++) {
    const y = 120 + row * 82;

    if (row % 2 === 0) {
      // 2 bolas grandes bien separadas
      for (let s = -1; s <= 1; s += 2) {
        const cx = WORLD_W / 2 + s * (180 + rand() * 60);
        const pr = 20 + rand() * 8;
        const peg = Bodies.circle(cx, y, pr, {
          isStatic: true, label: 'bumper',
          restitution: 0.65 + rand() * 0.2, friction: 0
        });
        peg._radius = pr;
        bodies.push(peg);
      }
    } else {
      // Barras péndulo (2 por fila, oscilan lentamente)
      [-1, 1].forEach(side => {
        const cx = WORLD_W / 2 + side * (140 + rand() * 60);
        const bw = 130 + rand() * 60;
        const bar = Bodies.rectangle(cx, y, bw, 12, {
          isStatic: true, label: 'pendulum',
          friction: 0.02, restitution: 0.45
        });
        bar._rw = bw; bar._rh = 12;
        bar._swingSpeed = 0.6 + rand() * 0.5;
        bar._swingAmp   = 0.3 + rand() * 0.3;
        bar._swingOff   = rand() * Math.PI * 2;
        bodies.push(bar);
        pendulumBars.push(bar);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ZONA 3: ASPAS GIRATORIAS  (y: 4100 ~ 5400, filas 50-65)
  // Cada aspa: una barra larga y delgada que gira continua.
  // Dos alturas por fila para más densidad sin bloquear.
  // ═══════════════════════════════════════════════════════════════════
  for (let row = 50; row < 66; row++) {
    const y = 120 + row * 82;

    if (row % 2 === 0) {
      // Aspa grande en el centro
      const sw = 200 + rand() * 100;
      const bar = Bodies.rectangle(WORLD_W / 2, y, sw, 10, {
        isStatic: true, label: 'spinner',
        restitution: 0.55, friction: 0.01
      });
      bar._rw = sw; bar._rh = 10;
      bar._spinSpeed = 0.8 + rand() * 1.2;
      bar._spinDir   = rand() > 0.5 ? 1 : -1;
      bodies.push(bar);
      spinnerBars.push(bar);
    }

    // Aspa lateral (desplazada 100px debajo para no solapar)
    if (rand() < 0.6) {
      const side  = rand() > 0.5 ? 1 : -1;
      const cx    = WORLD_W / 2 + side * (160 + rand() * 60);
      const sw    = 120 + rand() * 80;
      const bar   = Bodies.rectangle(cx, y + 41, sw, 10, {
        isStatic: true, label: 'spinner',
        restitution: 0.55, friction: 0.01
      });
      bar._rw = sw; bar._rh = 10;
      bar._spinSpeed = 0.6 + rand() * 1.0;
      bar._spinDir   = rand() > 0.5 ? 1 : -1;
      bodies.push(bar);
      spinnerBars.push(bar);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ZONA 4: ABIERTA  (y: 5400 ~ 6500)
  // Bolas grandes muy separadas, mucha caída libre
  // ═══════════════════════════════════════════════════════════════════
  for (let row = 66; row < 80; row++) {
    if (rand() < 0.5) continue;
    const y = 120 + row * 82;
    const n = 1 + Math.floor(rand() * 2);
    for (let c = 0; c < n; c++) {
      const x = 50 + rand() * (W - 100);
      const pr = 24 + rand() * 10;
      const tooClose = bodies.some(b => {
        if (!b.circleRadius) return false;
        return Math.sqrt((b.position.x - x) ** 2 + (b.position.y - y) ** 2) < (b.circleRadius + pr + 25);
      });
      if (tooClose) continue;
      const peg = Bodies.circle(x, y, pr, {
        isStatic: true, label: 'bumper',
        restitution: 0.75 + rand() * 0.2, friction: 0
      });
      peg._radius = pr;
      bodies.push(peg);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUPER BOLAS  (cada 14 filas, entre filas)
  // ═══════════════════════════════════════════════════════════════════
  for (let row = 5; row < 80; row += 14) {
    const y  = 120 + row * 82 + 41;
    const bx = 60 + rand() * (W - 120);
    const tooClose = bodies.some(b => {
      if (!b.circleRadius) return false;
      return Math.sqrt((b.position.x - bx) ** 2 + (b.position.y - y) ** 2) < (b.circleRadius + 28);
    });
    if (tooClose) continue;
    const big = Bodies.circle(bx, y, 22 + rand() * 6, {
      isStatic: true, label: 'bumper',
      restitution: 0.85, friction: 0
    });
    big._radius = big.circleRadius;
    bodies.push(big);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PRE-META  (6 bolas doradas)
  // ═══════════════════════════════════════════════════════════════════
  for (let k = 0; k < 6; k++) {
    const gy = FINISH_Y - 300 + k * 45;
    const gx = 50 + rand() * (W - 100);
    const gb = Bodies.circle(gx, gy, 18, {
      isStatic: true, label: 'bumper_finish',
      restitution: 0.85, friction: 0
    });
    gb._radius = 18;
    bodies.push(gb);
  }

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
  engine.gravity.y = 0.8;
  engine.timing.timeScale = 0.9;

  const rand        = seededRandom(gameState.seed);
  const trackBodies = buildTrack(rand);
  World.add(engine.world, trackBodies);

  gameState.trackBodies = trackBodies.map(serializeBody);

  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const body = Bodies.circle(startX, 60, R, {
      restitution: 0.5, friction: 0.005, frictionAir: 0.0005,
      label: 'marble_' + m.id, isSleeping: false
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 1.5, y: 4 });
    World.add(engine.world, body);
    marbleBodies.push({ id: m.id, body });
  });

  physicsLoop = setInterval(() => {
    const t = Date.now();
    const fanForce = Math.sin(t * 0.002) * FAN_STR;

    // Ventilador
    marbleBodies.forEach(({ body }) => {
      if (body.position.y > FAN_TOP && body.position.y < FAN_BOT) {
        Body.applyForce(body, body.position, { x: fanForce * (1 + Math.sin(t * 0.005) * 0.3), y: 0 });
      }
    });

    // Aspas giratorias
    spinnerBars.forEach(bar => {
      Body.setAngle(bar, bar.angle + bar._spinSpeed * bar._spinDir * (TICK_MS / 1000));
    });

    // Péndulos
    pendulumBars.forEach(bar => {
      const phase = (t * 0.001 * bar._swingSpeed + bar._swingOff) % (Math.PI * 2);
      Body.setAngle(bar, Math.sin(phase) * bar._swingAmp);
    });

    Engine.update(engine, TICK_MS);
    tickCount++;

    if (tickCount % EMIT_EVERY !== 0) return;

    const positions = marbleBodies.map(({ id, body }) => ({
      id, x: body.position.x, y: body.position.y, angle: body.angle
    }));
    io.emit('positions', { positions, fanPhase: Math.sin(t * 0.002) });

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
  spinnerBars  = [];
  pendulumBars = [];
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
      id: m.id, name: m.name, color: m.color,
      image: m.image || null, sound: m.sound || null, soundName: m.soundName || ''
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
