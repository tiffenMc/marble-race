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
  const wallL = Bodies.rectangle(WALL_W / 2, TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const wallR = Bodies.rectangle(WORLD_W - WALL_W / 2, TRACK_H / 2, WALL_W, TRACK_H, { isStatic: true, label: 'wall' });
  const floor = Bodies.rectangle(WORLD_W / 2, TRACK_H + 10, WORLD_W, 20, { isStatic: true, label: 'floor' });
  wallL._rw = WALL_W;  wallL._rh = TRACK_H;
  wallR._rw = WALL_W;  wallR._rh = TRACK_H;
  floor._rw = WORLD_W; floor._rh = 20;
  bodies.push(wallL, wallR, floor);

  // ─── RAMPLAS EN ZIGZAG CON SOLAPAMIENTO GARANTIZADO ────────────────
  // Cada rampa empieza en su pared y apunta hacia el centro.
  // Ancho mínimo 360px → las rampas izquierda y derecha SE SOLAPAN
  // en el centro entre 40-120px. La canica SIEMPRE cae sobre la siguiente.
  const RAMP_COUNT = 35;
  const GAP        = TRACK_H / (RAMP_COUNT + 1);
  const MIN_RW     = 360;
  const MAX_RW     = 480;

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';
    const rw   = MIN_RW + rand() * (MAX_RW - MIN_RW);
    const deg  = 5 + rand() * 8;
    const angle = deg * (Math.PI / 180) * (side === 'left' ? 1 : -1);

    const x = side === 'left' ? WALL_W + rw / 2 : WORLD_W - WALL_W - rw / 2;

    const ramp = Bodies.rectangle(x, y, rw, 10, {
      isStatic: true, angle, label: 'ramp',
      friction: 0.02, restitution: 0.35
    });
    ramp._rw = rw; ramp._rh = 10;
    bodies.push(ramp);
  }

  // ─── BUMPERS EN ZONA DE SOLAPAMIENTO (caos controlado) ─────────────
  // Sólo en la región central donde ambas rampas se solapan,
  // para que la canica siempre pueda pasar por izquierda o derecha.
  for (let i = 2; i < RAMP_COUNT; i += 3) {
    const y  = GAP * (i + 0.5);
    const bx = WORLD_W / 2 + (rand() - 0.5) * 100;
    const br = 10 + rand() * 10;
    const b  = Bodies.circle(bx, y, br, {
      isStatic: true, label: 'bumper',
      restitution: 0.75 + rand() * 0.2, friction: 0
    });
    b._radius = br;
    bodies.push(b);
  }

  // ─── ZONA RÁPIDA (pendiente suave, abierta) ───────────────────────
  const fastY = TRACK_H * 0.68;
  const fastRamp = Bodies.rectangle(WORLD_W / 2, fastY, 600, 12, {
    isStatic: true, angle: 0.15, label: 'ramp_fast',
    friction: 0.005, restitution: 0.3
  });
  fastRamp._rw = 600; fastRamp._rh = 12;
  bodies.push(fastRamp);

  for (let j = 0; j < 4; j++) {
    const bx = 60 + rand() * (WORLD_W - 120);
    const by = fastY + 80 + rand() * 150;
    const br = 18 + rand() * 10;
    const b  = Bodies.circle(bx, by, br, {
      isStatic: true, label: 'bumper',
      restitution: 0.8 + rand() * 0.15, friction: 0
    });
    b._radius = br;
    bodies.push(b);
  }

  // ─── PRE-META (embudo abierto + bumpers dorados) ──────────────────
  const preY = FINISH_Y - 350;
  const fL = Bodies.rectangle(220, preY, 380, 12, {
    isStatic: true, angle: 0.35, label: 'wall', friction: 0.01, restitution: 0.4
  });
  fL._rw = 380; fL._rh = 12;
  const fR = Bodies.rectangle(580, preY, 380, 12, {
    isStatic: true, angle: -0.35, label: 'wall', friction: 0.01, restitution: 0.4
  });
  fR._rw = 380; fR._rh = 12;
  bodies.push(fL, fR);

  for (let k = 0; k < 3; k++) {
    const gy = preY + 50 + k * 60;
    const gx = WORLD_W / 2 + (rand() - 0.5) * 140;
    const gb = Bodies.circle(gx, gy, 16, {
      isStatic: true, label: 'bumper_finish', restitution: 0.85, friction: 0
    });
    gb._radius = 16;
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
