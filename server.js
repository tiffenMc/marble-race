const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const Matter  = require('matter-js');
const { Engine, World, Bodies, Body } = Matter;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const WORLD_W    = 800;
const TRACK_H    = 7000;
const FINISH_Y   = TRACK_H - 200;
const R          = 22;
const TICK_MS    = 1000 / 60;
const EMIT_EVERY = 2;

// ─── ESTADO ───────────────────────────────────────────────────────────────────
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

// ─── ESCENARIO ────────────────────────────────────────────────────────────────
function buildTrack(rand) {
  const bodies = [];

  const wallL = Bodies.rectangle(10,           TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' });
  const wallR = Bodies.rectangle(WORLD_W - 10, TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' });
  const floor = Bodies.rectangle(WORLD_W / 2,  TRACK_H + 10, WORLD_W, 20,    { isStatic: true, label: 'floor' });

  // Guardamos dimensiones REALES (pre-rotación) en propiedades propias
  wallL._rw = 20;       wallL._rh = TRACK_H;
  wallR._rw = 20;       wallR._rh = TRACK_H;
  floor._rw = WORLD_W;  floor._rh = 20;

  bodies.push(wallL, wallR, floor);

  const RAMP_COUNT  = 26;
  const GAP         = TRACK_H / (RAMP_COUNT + 1);
  const RAMP_W      = 320;
  const RAMP_T      = 16;
  const SIDE_MARGIN = 20;

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';
    const deg   = rand() * 10 + 8;
    const angle = deg * (Math.PI / 180) * (side === 'left' ? 1 : -1);

    const x = side === 'left'
      ? SIDE_MARGIN + RAMP_W / 2
      : WORLD_W - SIDE_MARGIN - RAMP_W / 2;

    const ramp = Bodies.rectangle(x, y, RAMP_W, RAMP_T, {
      isStatic: true, angle, label: 'ramp', friction: 0.04, restitution: 0.15
    });
    // Dimensiones reales de la rampa (sin rotar)
    ramp._rw = RAMP_W;
    ramp._rh = RAMP_T;
    bodies.push(ramp);

    const bumpX = side === 'left'
      ? SIDE_MARGIN + RAMP_W + 60
      : WORLD_W - SIDE_MARGIN - RAMP_W - 60;

    const bump = Bodies.circle(bumpX, y + 30, 18, {
      isStatic: true, label: 'bumper', restitution: 0.7, friction: 0
    });
    // Radio real del bumper
    bump._radius = 18;
    bodies.push(bump);
  }

  return bodies;
}

// ─── SERIALIZACIÓN ────────────────────────────────────────────────────────────
// IMPORTANTE: enviamos rw/rh (dimensiones reales pre-rotación) y radius.
// El cliente NUNCA debe usar el bounding box de Matter (que está rotado).
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

// ─── FÍSICA ───────────────────────────────────────────────────────────────────
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
      restitution: 0.4, friction: 0.01, frictionAir: 0.002, label: 'marble_' + m.id
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 4, y: 2 });
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

// ─── SOCKETS ─────────────────────────────────────────────────────────────────
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
