const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Matter = require('matter-js');

const { Engine, World, Bodies, Body, Runner } = Matter;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const WORLD_W  = 800;
const TRACK_H  = 7000;
const FINISH_Y = TRACK_H - 200;
const R        = 22;
const EMIT_MS  = 1000 / 30;

// ─── ESTADO GLOBAL ───────────────────────────────────────────────────────────
let gameState = {
  phase: 'setup',
  marbles: [],
  round: 1,
  scores: {},
  trackBodies: [],
  currentLeader: null,
  seed: null
};

let engine       = null;
let runner       = null;
let marbleBodies = [];
let emitLoop     = null;
let raceFinished = false;

function broadcastState() {
  const { phase, marbles, round, scores, currentLeader, seed } = gameState;
  io.emit('stateUpdate', { phase, marbles, round, scores, currentLeader, seed });
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// ─── ESCENARIO ───────────────────────────────────────────────────────────────
function buildTrack(rand) {
  const bodies = [];

  bodies.push(
    Bodies.rectangle(0,           TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' }),
    Bodies.rectangle(WORLD_W,     TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' }),
    Bodies.rectangle(WORLD_W / 2, TRACK_H + 10, WORLD_W, 20,    { isStatic: true, label: 'floor' })
  );

  const RAMP_COUNT  = 28;
  const GAP         = TRACK_H / (RAMP_COUNT + 1);
  const RAMP_W      = 300;
  const RAMP_T      = 14;
  const SIDE_MARGIN = 60;

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';
    const angle = (rand() * 10 + 10) * (Math.PI / 180) * (side === 'left' ? 1 : -1);
    const x    = side === 'left'
      ? SIDE_MARGIN + RAMP_W / 2
      : WORLD_W - SIDE_MARGIN - RAMP_W / 2;

    bodies.push(
      Bodies.rectangle(x, y, RAMP_W, RAMP_T, {
        isStatic: true, angle, label: 'ramp', friction: 0.05, restitution: 0.2
      })
    );

    const bumpX = side === 'left'
      ? SIDE_MARGIN + RAMP_W + 80
      : WORLD_W - SIDE_MARGIN - RAMP_W - 80;

    bodies.push(
      Bodies.circle(bumpX, y - 20, 12, {
        isStatic: true, label: 'bumper', restitution: 0.6, friction: 0
      })
    );
  }

  return bodies;
}

function serializeBody(b) {
  return {
    label:  b.label,
    x:      b.position.x,
    y:      b.position.y,
    angle:  b.angle,
    width:  b.bounds.max.x - b.bounds.min.x,
    height: b.bounds.max.y - b.bounds.min.y,
    radius: b.circleRadius || null
  };
}

// ─── FÍSICA ──────────────────────────────────────────────────────────────────
function startPhysics() {
  destroyRace();
  raceFinished = false;

  engine = Engine.create();
  engine.gravity.y = 0.8;

  const rand = seededRandom(gameState.seed);

  // 1. Construir escenario
  const trackBodies = buildTrack(rand);
  World.add(engine.world, trackBodies);

  // 2. Serializar DESPUÉS de crearlos (aquí está el fix del bug)
  gameState.trackBodies = trackBodies.map(serializeBody);

  // 3. Canicas
  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const body = Bodies.circle(startX, 60, R, {
      restitution: 0.4, friction: 0.01, frictionAir: 0.003, label: 'marble_' + m.id
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 3, y: 1 });
    World.add(engine.world, body);
    marbleBodies.push({ id: m.id, body });
  });

  // 4. Runner
  runner = Runner.create();
  Runner.run(runner, engine);

  // 5. Loop de emisión
  emitLoop = setInterval(() => {
    if (!engine) return;

    const positions = marbleBodies.map(({ id, body }) => ({
      id, x: body.position.x, y: body.position.y, angle: body.angle
    }));
    io.emit('positions', positions);

    // Líder
    if (marbleBodies.length) {
      const leader = marbleBodies.reduce((a, b) =>
        a.body.position.y > b.body.position.y ? a : b
      );
      if (leader.id !== gameState.currentLeader) {
        gameState.currentLeader = leader.id;
        io.emit('leaderChange', leader.id);
      }
    }

    // Meta
    if (!raceFinished) {
      for (const { id, body } of marbleBodies) {
        if (body.position.y >= FINISH_Y) {
          raceFinished = true;
          endRace(id);
          break;
        }
      }
    }
  }, EMIT_MS);
}

function endRace(winnerId) {
  clearInterval(emitLoop);
  emitLoop = null;

  const sorted = [...marbleBodies].sort((a, b) => b.body.position.y - a.body.position.y);
  sorted.forEach((entry, i) => {
    if (!gameState.scores[entry.id]) gameState.scores[entry.id] = 0;
    if (i === 0) gameState.scores[entry.id] += 3;
    else if (i === 1) gameState.scores[entry.id] += 1;
  });

  gameState.phase         = 'results';
  gameState.currentLeader = winnerId;

  broadcastState();
  io.emit('raceWinner', { winnerId, scores: gameState.scores });

  setTimeout(() => destroyRace(), 3000);
}

function destroyRace() {
  clearInterval(emitLoop);
  emitLoop = null;
  if (runner) Runner.stop(runner);
  if (engine) { World.clear(engine.world); Engine.clear(engine); }
  engine = runner = null;
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
    gameState.marbles = marbles;
    marbles.forEach(m => { if (gameState.scores[m.id] === undefined) gameState.scores[m.id] = 0; });
    broadcastState();
  });

  socket.on('setPhase', phase => {
    gameState.phase = phase;
    broadcastState();
  });

  socket.on('startRace', () => {
    if (!gameState.marbles.length) return;
    gameState.phase = 'racing';
    gameState.seed  = Date.now();

    startPhysics(); // <- rellena gameState.trackBodies internamente
    broadcastState();
    io.emit('trackData', gameState.trackBodies); // <- ahora ya no está vacío
  });

  socket.on('nextRound', () => {
    destroyRace();
    gameState.round++;
    gameState.phase         = 'ready';
    gameState.currentLeader = null;
    gameState.trackBodies   = [];
    broadcastState();
  });

  // NUEVO: reset de la carrera actual (conserva canicas y puntos)
  socket.on('resetRace', () => {
    destroyRace();
    gameState.phase         = 'ready';
    gameState.currentLeader = null;
    gameState.trackBodies   = [];
    broadcastState();
    io.emit('raceReset');
  });

  socket.on('resetGame', () => {
    destroyRace();
    gameState = {
      phase: 'setup', marbles: [], round: 1, scores: {},
      trackBodies: [], currentLeader: null, seed: null
    };
    broadcastState();
  });

  socket.on('disconnect', () => console.log('Desconectado:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
