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
const WORLD_W  = 600;   // ancho del mundo físico (píxeles lógicos)
const TRACK_H  = 8000;
const FINISH_Y = TRACK_H - 300;
const R        = 20;
const TICK_MS  = 1000 / 60;
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
// Devuelve array de objetos con toda la info necesaria para física Y dibujo
function buildTrack(rand) {
  const trackDef = [];   // definición lógica (para serializar al cliente)
  const bodies   = [];   // bodies de Matter.js

  // ── Paredes ──
  const addWall = (x, y, w, h) => {
    trackDef.push({ type: 'rect', x, y, w, h, angle: 0, style: 'wall' });
    bodies.push(Bodies.rectangle(x, y, w, h, { isStatic: true, label: 'wall' }));
  };
  addWall(5,            TRACK_H / 2, 10,      TRACK_H); // pared izq
  addWall(WORLD_W - 5,  TRACK_H / 2, 10,      TRACK_H); // pared der
  addWall(WORLD_W / 2,  TRACK_H + 5, WORLD_W, 10);      // suelo

  // ── Rampas en zigzag ──
  const RAMP_COUNT  = 30;
  const GAP         = TRACK_H / (RAMP_COUNT + 1);
  const RAMP_W      = 340;   // cubre hasta casi la mitad del mundo
  const RAMP_T      = 18;
  const WALL_GAP    = 10;    // distancia desde la pared

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';
    const deg  = rand() * 8 + 7;   // 7°–15°
    const angle = deg * (Math.PI / 180) * (side === 'left' ? 1 : -1);

    // Centro de la rampa: pegada a la pared de su lado
    const cx = side === 'left'
      ? WALL_GAP + RAMP_W / 2
      : WORLD_W - WALL_GAP - RAMP_W / 2;

    trackDef.push({ type: 'rect', x: cx, y, w: RAMP_W, h: RAMP_T, angle, style: 'ramp' });
    bodies.push(
      Bodies.rectangle(cx, y, RAMP_W, RAMP_T, {
        isStatic: true, angle, label: 'ramp', friction: 0.03, restitution: 0.2
      })
    );

    // Bumper circular al final del hueco (guía las canicas)
    const bx = side === 'left'
      ? WALL_GAP + RAMP_W + 40
      : WORLD_W - WALL_GAP - RAMP_W - 40;

    trackDef.push({ type: 'circle', x: bx, y: y + 35, r: 16, style: 'bumper' });
    bodies.push(
      Bodies.circle(bx, y + 35, 16, {
        isStatic: true, label: 'bumper', restitution: 0.75, friction: 0
      })
    );
  }

  // ── Canalizadores: pequeñas pegs en el centro para añadir variedad ──
  for (let i = 0; i < 12; i++) {
    const px = WORLD_W * (0.3 + rand() * 0.4);
    const py = (TRACK_H / 14) * (i + 1) + rand() * 80 - 40;
    trackDef.push({ type: 'circle', x: px, y: py, r: 10, style: 'peg' });
    bodies.push(
      Bodies.circle(px, py, 10, {
        isStatic: true, label: 'peg', restitution: 0.5, friction: 0
      })
    );
  }

  return { trackDef, bodies };
}

// ─── FÍSICA ───────────────────────────────────────────────────────────────────
function startPhysics() {
  destroyRace();
  raceFinished = false;
  tickCount    = 0;

  engine = Engine.create();
  engine.gravity.y = 1.0;

  const rand = seededRandom(gameState.seed);
  const { trackDef, bodies } = buildTrack(rand);

  World.add(engine.world, bodies);

  // Guardar trackDef (ya tiene w/h reales, no bounds)
  gameState.trackBodies = trackDef;

  // Canicas — posición inicial repartida
  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const body = Bodies.circle(startX, 50, R, {
      restitution: 0.35, friction: 0.008, frictionAir: 0.002, label: 'marble_' + m.id
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 3, y: 1 });
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
  setTimeout(() => destroyRace(), 4000);
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

  // Si ya hay track generado (fase ready, racing o results) mandar al recién llegado
  if (gameState.trackBodies.length) {
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

  // FASE READY: generar y enviar escenario SIN iniciar física todavía
  socket.on('showTrack', () => {
    if (!gameState.marbles.length) return;
    gameState.seed = Date.now();
    const rand = seededRandom(gameState.seed);
    // Solo necesitamos buildTrack para el dibujo, sin física
    // Pero para consistencia, generamos el mismo track que luego usará startPhysics
    const { trackDef } = buildTrack(rand);
    gameState.trackBodies = trackDef;
    gameState.phase = 'ready';
    broadcastState();
    io.emit('trackData', gameState.trackBodies);
  });

  socket.on('startRace', () => {
    if (!gameState.marbles.length) return;
    // Si ya hay seed (viene de showTrack), reutilizarla para mismo escenario
    if (!gameState.seed) gameState.seed = Date.now();
    gameState.phase = 'racing';
    startPhysics();   // usa gameState.seed — genera el mismo trackDef + bodies
    broadcastState();
    io.emit('trackData', gameState.trackBodies);  // reenviar por si alguien se conectó tarde
  });

  socket.on('nextRound', () => {
    destroyRace();
    gameState.round++;
    gameState.phase = 'lobby';
    gameState.currentLeader = null;
    gameState.trackBodies = [];
    gameState.seed = null;
    broadcastState();
  });

  socket.on('resetRace', () => {
    destroyRace();
    gameState.phase = 'lobby';
    gameState.currentLeader = null;
    gameState.trackBodies = [];
    gameState.seed = null;
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
