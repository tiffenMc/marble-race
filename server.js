const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Matter = require('matter-js');

const { Engine, World, Bodies, Body, Runner, Composite } = Matter;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

// ─── CONSTANTES MUNDO ────────────────────────────────────────────────────────
const WORLD_W   = 800;
const TRACK_H   = 7000;
const FINISH_Y  = TRACK_H - 200;
const R         = 22;
const TICK_MS   = 1000 / 60;   // 60 Hz física
const EMIT_MS   = 1000 / 30;   // 30 Hz red

// ─── ESTADO GLOBAL ───────────────────────────────────────────────────────────
let gameState = {
  phase: 'setup',
  marbles: [],        // datos visuales (nombre, color, imagen, sonido)
  round: 1,
  scores: {},
  trackBodies: [],    // geometría del escenario (enviada 1 sola vez)
  currentLeader: null,
  seed: null
};

let engine       = null;
let runner       = null;
let marbleBodies = [];   // { id, body }
let raceLoop     = null;
let emitLoop     = null;
let raceFinished = false;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function broadcastState() {
  // No incluimos trackBodies aquí (son grandes), se envían aparte
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

// ─── GENERACIÓN DE ESCENARIO SIN BLOQUEOS ────────────────────────────────────
// Estrategia: rampas en zigzag alternado con un GAP GARANTIZADO en el centro
// para que siempre haya camino libre.
function buildTrack(rand) {
  const staticBodies = [];

  // Paredes laterales
  staticBodies.push(
    Bodies.rectangle(0,          TRACK_H / 2, 20, TRACK_H, { isStatic: true, label: 'wall' }),
    Bodies.rectangle(WORLD_W,    TRACK_H / 2, 20, TRACK_H, { isStatic: true, label: 'wall' }),
    Bodies.rectangle(WORLD_W / 2, TRACK_H + 10, WORLD_W, 20, { isStatic: true, label: 'floor' })
  );

  // Plataformas en zigzag garantizadas sin cerrar el paso
  const RAMP_COUNT   = 28;
  const GAP          = TRACK_H / (RAMP_COUNT + 1);
  const RAMP_W       = 300;   // longitud de la rampa (no llega a la otra pared)
  const RAMP_T       = 14;    // grosor
  const SIDE_MARGIN  = 60;    // separación mínima de la pared
  const FREE_GAP     = 160;   // ancho del hueco libre siempre presente

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    // Alternamos lado: izquierda / derecha
    const side = i % 2 === 0 ? 'left' : 'right';
    // Ángulo suave (+/-15°)
    const angle = (rand() * 10 + 10) * (Math.PI / 180) * (side === 'left' ? 1 : -1);

    let x;
    if (side === 'left') {
      // La rampa empieza en la pared izquierda y deja hueco a la derecha
      x = SIDE_MARGIN + RAMP_W / 2;
    } else {
      // La rampa empieza en la pared derecha y deja hueco a la izquierda
      x = WORLD_W - SIDE_MARGIN - RAMP_W / 2;
    }

    const ramp = Bodies.rectangle(x, y, RAMP_W, RAMP_T, {
      isStatic: true,
      angle,
      label: 'ramp',
      friction: 0.05,
      restitution: 0.2
    });

    staticBodies.push(ramp);

    // Pequeño bumper circular en el extremo libre para guiar las canicas
    const bumpX = side === 'left'
      ? SIDE_MARGIN + RAMP_W + FREE_GAP / 2
      : WORLD_W - SIDE_MARGIN - RAMP_W - FREE_GAP / 2;

    staticBodies.push(
      Bodies.circle(bumpX, y - 20, 12, {
        isStatic: true,
        label: 'bumper',
        restitution: 0.6,
        friction: 0
      })
    );
  }

  return staticBodies;
}

// ─── INICIAR FÍSICA ──────────────────────────────────────────────────────────
function startPhysics() {
  destroyRace();
  raceFinished = false;

  engine = Engine.create();
  engine.gravity.y = 0.8;

  const seed = gameState.seed || Date.now();
  gameState.seed = seed;
  const rand = seededRandom(seed);

  // Construir escenario
  const trackBodies = buildTrack(rand);
  World.add(engine.world, trackBodies);

  // Serializar geometría para el cliente (solo posición y forma)
  gameState.trackBodies = trackBodies.map(b => ({
    label:     b.label,
    x:         b.position.x,
    y:         b.position.y,
    angle:     b.angle,
    width:     b.bounds.max.x - b.bounds.min.x,
    height:    b.bounds.max.y - b.bounds.min.y,
    radius:    b.circleRadius || null
  }));

  // Añadir canicas
  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const startY = 60;
    const body = Bodies.circle(startX, startY, R, {
      restitution: 0.4,
      friction: 0.01,
      frictionAir: 0.003,
      label: 'marble_' + m.id
    });
    // Pequeño empujón inicial aleatorio para variar
    Body.setVelocity(body, { x: (rand() - 0.5) * 3, y: 1 });
    World.add(engine.world, body);
    marbleBodies.push({ id: m.id, body });
  });

  // Runner de Matter.js
  runner = Runner.create();
  Runner.run(runner, engine);

  // Loop de emisión de posiciones (30 Hz)
  emitLoop = setInterval(() => {
    if (!engine) return;

    const positions = marbleBodies.map(({ id, body }) => ({
      id,
      x: body.position.x,
      y: body.position.y,
      angle: body.angle
    }));

    // Detectar líder (mayor Y = más abajo = más avanzado)
    const inRace = marbleBodies.filter(({ body }) => !body.isSleeping);
    if (inRace.length) {
      const leader = inRace.reduce((a, b) =>
        a.body.position.y > b.body.position.y ? a : b
      );
      if (leader.id !== gameState.currentLeader) {
        gameState.currentLeader = leader.id;
        io.emit('leaderChange', leader.id);
      }
    }

    io.emit('positions', positions);

    // Comprobar si alguien llegó a la meta
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

// ─── FIN DE CARRERA ──────────────────────────────────────────────────────────
function endRace(winnerId) {
  clearInterval(emitLoop);
  emitLoop = null;

  if (!gameState.scores[winnerId]) gameState.scores[winnerId] = 0;
  gameState.scores[winnerId] += 3;

  // Puntos al 2º y 3º (por orden de llegada aproximado)
  const sorted = [...marbleBodies].sort((a, b) => b.body.position.y - a.body.position.y);
  if (sorted[1]) {
    const id2 = sorted[1].id;
    if (!gameState.scores[id2]) gameState.scores[id2] = 0;
    gameState.scores[id2] += 1;
  }

  gameState.phase    = 'results';
  gameState.currentLeader = winnerId;

  broadcastState();
  io.emit('raceWinner', { winnerId, scores: gameState.scores });

  // Parar física después de 3s
  setTimeout(() => destroyRace(), 3000);
}

// ─── DESTRUIR FÍSICA ─────────────────────────────────────────────────────────
function destroyRace() {
  clearInterval(emitLoop);
  clearInterval(raceLoop);
  emitLoop = raceLoop = null;

  if (runner) Runner.stop(runner);
  if (engine) { World.clear(engine.world); Engine.clear(engine); }
  engine = runner = null;
  marbleBodies = [];
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Conectado:', socket.id);

  // Enviar estado actual al nuevo cliente
  socket.emit('stateUpdate', {
    phase:         gameState.phase,
    marbles:       gameState.marbles,
    round:         gameState.round,
    scores:        gameState.scores,
    currentLeader: gameState.currentLeader,
    seed:          gameState.seed
  });

  // Si la carrera ya empezó, enviar el escenario
  if (gameState.phase === 'racing' || gameState.phase === 'results') {
    socket.emit('trackData', gameState.trackBodies);
  }

  socket.on('setMarbles', marbles => {
    gameState.marbles = marbles;
    marbles.forEach(m => { if (!gameState.scores[m.id]) gameState.scores[m.id] = 0; });
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
    broadcastState();

    // Enviar geometría del escenario a todos (se calcula dentro de startPhysics)
    startPhysics();
    io.emit('trackData', gameState.trackBodies);
  });

  socket.on('nextRound', () => {
    gameState.round++;
    gameState.phase = 'ready';
    gameState.currentLeader = null;
    broadcastState();
  });

  socket.on('resetGame', () => {
    destroyRace();
    gameState = {
      phase:         'setup',
      marbles:       [],
      round:         1,
      scores:        {},
      trackBodies:   [],
      currentLeader: null,
      seed:          null
    };
    broadcastState();
  });

  socket.on('disconnect', () => console.log('Desconectado:', socket.id));
});

// ─── ARRANCAR ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
