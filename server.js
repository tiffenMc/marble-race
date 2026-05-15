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

  const wallL = Bodies.rectangle(10,           TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' });
  const wallR = Bodies.rectangle(WORLD_W - 10, TRACK_H / 2, 20,      TRACK_H, { isStatic: true, label: 'wall' });
  const floor = Bodies.rectangle(WORLD_W / 2,  TRACK_H + 10, WORLD_W, 20,    { isStatic: true, label: 'floor' });
  wallL._rw = 20;       wallL._rh = TRACK_H;
  wallR._rw = 20;       wallR._rh = TRACK_H;
  floor._rw = WORLD_W;  floor._rh = 20;
  bodies.push(wallL, wallR, floor);

  const RAMP_COUNT  = 40;
  const GAP         = TRACK_H / (RAMP_COUNT + 1);
  const SIDE_MARGIN = 55;

  for (let i = 0; i < RAMP_COUNT; i++) {
    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';
    const RAMP_W = 160 + rand() * 200;
    const deg   = 5 + rand() * 15;
    const angle = deg * (Math.PI / 180) * (side === 'left' ? 1 : -1);
    const x = side === 'left' ? SIDE_MARGIN + RAMP_W / 2 : WORLD_W - SIDE_MARGIN - RAMP_W / 2;

    const ramp = Bodies.rectangle(x, y, RAMP_W, 12, {
      isStatic: true, angle, label: 'ramp', friction: 0.02, restitution: 0.3
    });
    ramp._rw = RAMP_W; ramp._rh = 12;
    bodies.push(ramp);

    const bumpX = side === 'left' ? SIDE_MARGIN + RAMP_W + 45 : WORLD_W - SIDE_MARGIN - RAMP_W - 45;
    const bumpR = 12 + rand() * 12;
    const bump = Bodies.circle(bumpX, y + 25, bumpR, {
      isStatic: true, label: 'bumper', restitution: 0.75, friction: 0
    });
    bump._radius = bumpR;
    bodies.push(bump);

    if (i % 3 === 0) {
      const defX = side === 'left' ? 16 : WORLD_W - 16;
      const defY = y + 50;
      const def = Bodies.rectangle(defX, defY, 10, 40, {
        isStatic: true, angle: (side === 'left' ? 0.6 : -0.6),
        label: 'wall', friction: 0.01, restitution: 0.5
      });
      def._rw = 10; def._rh = 40;
      bodies.push(def);
    }

    if (i % 3 === 1) {
      const midBump = Bodies.circle(WORLD_W / 2 + (rand() - 0.5) * 100, y - GAP * 0.4, 10 + rand() * 10, {
        isStatic: true, label: 'bumper', restitution: 0.8, friction: 0
      });
      midBump._radius = midBump.circleRadius;
      bodies.push(midBump);
    }
  }

  const funnelY = TRACK_H * 0.45;
  const fL = Bodies.rectangle(180, funnelY, 200, 12, {
    isStatic: true, angle: 0.6, label: 'funnel', friction: 0.01, restitution: 0.3
  });
  fL._rw = 200; fL._rh = 12;
  const fR = Bodies.rectangle(620, funnelY, 200, 12, {
    isStatic: true, angle: -0.6, label: 'funnel', friction: 0.01, restitution: 0.3
  });
  fR._rw = 200; fR._rh = 12;
  bodies.push(fL, fR);
  const fBump = Bodies.circle(WORLD_W / 2, funnelY + 80, 26, {
    isStatic: true, label: 'bumper_big', restitution: 0.9, friction: 0
  });
  fBump._radius = 26;
  bodies.push(fBump);

  const accelY = TRACK_H * 0.72;
  const accelRamp = Bodies.rectangle(WORLD_W / 2, accelY, 550, 14, {
    isStatic: true, angle: 0.2, label: 'ramp_fast', friction: 0.01, restitution: 0.25
  });
  accelRamp._rw = 550; accelRamp._rh = 14;
  bodies.push(accelRamp);
  for (let j = 0; j < 4; j++) {
    const ab = Bodies.circle(WORLD_W * 0.15 + rand() * WORLD_W * 0.7, accelY + 80 + rand() * 60, 16 + rand() * 8, {
      isStatic: true, label: 'bumper', restitution: 0.85, friction: 0
    });
    ab._radius = ab.circleRadius;
    bodies.push(ab);
  }

  const preFinishY = FINISH_Y - 350;
  [[0.5, 0], [0.35, 90], [0.65, 90], [0.42, 170], [0.58, 170]].forEach(([xFrac, yOff]) => {
    const tb = Bodies.circle(WORLD_W * xFrac, preFinishY + yOff, 18, {
      isStatic: true, label: 'bumper_finish', restitution: 0.85, friction: 0
    });
    tb._radius = 18;
    bodies.push(tb);
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
  engine.gravity.y = 1.0;

  const rand        = seededRandom(gameState.seed);
  const trackBodies = buildTrack(rand);
  World.add(engine.world, trackBodies);

  gameState.trackBodies = trackBodies.map(serializeBody);

  marbleBodies = [];
  const count = gameState.marbles.length;
  gameState.marbles.forEach((m, i) => {
    const startX = (WORLD_W / (count + 1)) * (i + 1);
    const body = Bodies.circle(startX, 60, R, {
      restitution: 0.45, friction: 0.01, frictionAir: 0.0008, label: 'marble_' + m.id
    });
    Body.setVelocity(body, { x: (rand() - 0.5) * 3, y: 3 });
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
