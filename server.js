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

  // ─── TABLERO PLINKO ───────────────────────────────────────────────
  // Filas de bolas (bumpers) en retícula triangular.
  // El hueco entre dos bolas adyacentes es > diámetro de la canica (44px)
  // para que SIEMPRE pueda pasar, pero justo — así rebota y se desvía.
  // Cada fila está descentrada respecto a la anterior (triangular lattice).
  const S        = 80;          // separación entre centros de bolas (px)
  const ROWS     = 80;          // 80 filas
  const ROW_GAP  = 85;          // 85px entre filas
  const START_Y  = 120;
  const MIN_PR   = 8;
  const MAX_PR   = 14;

  for (let row = 0; row < ROWS; row++) {
    const y       = START_Y + row * ROW_GAP;
    const isEven  = row % 2 === 0;
    const offsetX = isEven ? 0 : S / 2;
    const count   = isEven ? 9 : 8;

    for (let col = 0; col < count; col++) {
      const x = WALL_W + S + offsetX + col * S;

      if (x < WALL_W + R + 10 || x > WORLD_W - WALL_W - R - 10) continue;

      const isBoost = rand() < 0.12;
      const pr = MIN_PR + rand() * (MAX_PR - MIN_PR);

      const peg = Bodies.circle(x, y, pr, {
        isStatic: true, label: 'bumper',
        restitution: isBoost ? 0.92 : 0.6 + rand() * 0.2,
        friction: 0
      });
      peg._radius = pr;
      bodies.push(peg);
    }
  }

  // ─── SUPER BOLAS (cada ~15 filas, más grandes, más rebote) ───────
  // Se colocan ENTRE filas para no solaparse con la retícula.
  for (let row = 3; row < ROWS; row += 15) {
    const y  = START_Y + row * ROW_GAP + ROW_GAP / 2;
    const bx = 50 + rand() * (WORLD_W - 100);

    const tooClose = bodies.some(b => {
      if (!b.circleRadius) return false;
      const dx = b.position.x - bx;
      const dy = b.position.y - y;
      return Math.sqrt(dx * dx + dy * dy) < (b.circleRadius + 22 + 8);
    });
    if (tooClose) continue;

    const br = 16 + rand() * 6;
    const big = Bodies.circle(bx, y, br, {
      isStatic: true, label: 'bumper',
      restitution: 0.75 + rand() * 0.2, friction: 0
    });
    big._radius = br;
    bodies.push(big);
  }

  // ─── PRE-META (6 bolas doradas flotando, muy separadas) ──────────
  const preY = FINISH_Y - 300;
  for (let k = 0; k < 6; k++) {
    const gy = preY + k * 45;
    const gx = 40 + rand() * (WORLD_W - 80);

    const tooClose = bodies.some(b => {
      if (!b.circleRadius) return false;
      const dx = b.position.x - gx;
      const dy = b.position.y - gy;
      return Math.sqrt(dx * dx + dy * dy) < (b.circleRadius + 22 + 10);
    });
    if (tooClose) continue;

    const gb = Bodies.circle(gx, gy, 16, {
      isStatic: true, label: 'bumper_finish',
      restitution: 0.8 + rand() * 0.15, friction: 0
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
  engine.gravity.y = 0.8;

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
    Body.setVelocity(body, { x: (rand() - 0.5) * 2, y: 3 });
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
