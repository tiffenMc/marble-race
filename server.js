const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const Matter  = require('matter-js');

const {
  Engine,
  World,
  Bodies,
  Body
} = Matter;

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

const WORLD_W    = 800;
const TRACK_H    = 7000;
const FINISH_Y   = TRACK_H - 200;
const R          = 22;
const TICK_MS    = 1000 / 60;
const EMIT_EVERY = 2;

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
let marbleBodies = [];
let physicsLoop  = null;
let tickCount    = 0;
let raceFinished = false;

function seededRandom(seed) {

  let s = seed;

  return () => {

    s = (s * 9301 + 49297) % 233280;

    return s / 233280;
  };
}

function serializeBody(b) {

  return {
    label: b.label,
    x: b.position.x,
    y: b.position.y,
    angle: b.angle,
    rw: b._rw || null,
    rh: b._rh || null,
    radius: b._radius || b.circleRadius || null
  };
}

function buildTrack(rand) {

  const bodies = [];

  // paredes
  const wallL = Bodies.rectangle(
    10,
    TRACK_H / 2,
    20,
    TRACK_H,
    {
      isStatic: true,
      label: 'wall'
    }
  );

  const wallR = Bodies.rectangle(
    WORLD_W - 10,
    TRACK_H / 2,
    20,
    TRACK_H,
    {
      isStatic: true,
      label: 'wall'
    }
  );

  wallL._rw = 20;
  wallL._rh = TRACK_H;

  wallR._rw = 20;
  wallR._rh = TRACK_H;

  bodies.push(wallL, wallR);

  // suelo
  const floor = Bodies.rectangle(
    WORLD_W / 2,
    TRACK_H + 20,
    WORLD_W,
    40,
    {
      isStatic: true,
      label: 'floor'
    }
  );

  floor._rw = WORLD_W;
  floor._rh = 40;

  bodies.push(floor);

  // rampas
  const RAMP_COUNT  = 26;
  const GAP         = TRACK_H / (RAMP_COUNT + 1);
  const RAMP_W      = 240;
  const RAMP_T      = 16;
  const SIDE_MARGIN = 20;

  for (let i = 0; i < RAMP_COUNT; i++) {

    const y    = GAP * (i + 1);
    const side = i % 2 === 0 ? 'left' : 'right';

    const deg = rand() * 14 + 16;

    const angle =
      deg * (Math.PI / 180) *
      (side === 'left' ? 1 : -1);

    const x = side === 'left'
      ? SIDE_MARGIN + RAMP_W / 2
      : WORLD_W - SIDE_MARGIN - RAMP_W / 2;

    const ramp = Bodies.rectangle(
      x,
      y,
      RAMP_W,
      RAMP_T,
      {
        isStatic: true,
        angle,
        label: 'ramp',
        friction: 0.01,
        restitution: 0.2
      }
    );

    ramp._rw = RAMP_W;
    ramp._rh = RAMP_T;

    bodies.push(ramp);

    // bumper lateral
    const bumpX = side === 'left'
      ? SIDE_MARGIN + RAMP_W + 60
      : WORLD_W - SIDE_MARGIN - RAMP_W - 60;

    const bump = Bodies.circle(
      bumpX,
      y + 30,
      18,
      {
        isStatic: true,
        label: 'bumper',
        restitution: 0.9,
        friction: 0
      }
    );

    bump._radius = 18;

    bodies.push(bump);

    // bumpers centrales
    if (i % 3 === 1) {

      const midBump = Bodies.circle(
        WORLD_W / 2 + (rand() - 0.5) * 100,
        y - GAP * 0.4,
        14,
        {
          isStatic: true,
          label: 'bumper',
          restitution: 0.8,
          friction: 0
        }
      );

      midBump._radius = 14;

      bodies.push(midBump);
    }
  }

  // embudo
  const funnelY = TRACK_H * 0.5;

  const fL = Bodies.rectangle(
    200,
    funnelY,
    180,
    14,
    {
      isStatic: true,
      angle: 0.38,
      label: 'funnel'
    }
  );

  fL._rw = 180;
  fL._rh = 14;

  const fR = Bodies.rectangle(
    600,
    funnelY,
    180,
    14,
    {
      isStatic: true,
      angle: -0.38,
      label: 'funnel'
    }
  );

  fR._rw = 180;
  fR._rh = 14;

  bodies.push(fL, fR);

  // bumper central
  const fBump = Bodies.circle(
    WORLD_W / 2,
    funnelY + 60,
    22,
    {
      isStatic: true,
      label: 'bumper_big',
      restitution: 0.9,
      friction: 0
    }
  );

  fBump._radius = 22;

  bodies.push(fBump);

  // bumpers anti stuck
  for (let i = 0; i < 4; i++) {

    const escapeBump = Bodies.circle(
      180 + i * 140,
      funnelY + 140,
      12,
      {
        isStatic: true,
        label: 'bumper',
        restitution: 0.9,
        friction: 0
      }
    );

    escapeBump._radius = 12;

    bodies.push(escapeBump);
  }

  return bodies;
}

function startPhysics() {

  destroyRace();

  raceFinished = false;
  tickCount    = 0;

  engine = Engine.create();

  engine.gravity.y = 1.15;

  const rand = seededRandom(gameState.seed);

  const trackBodies = buildTrack(rand);

  World.add(engine.world, trackBodies);

  gameState.trackBodies =
    trackBodies.map(serializeBody);

  marbleBodies = [];

  const count = gameState.marbles.length;

  gameState.marbles.forEach((m, i) => {

    const startX =
      (WORLD_W / (count + 1)) * (i + 1);

    const body = Bodies.circle(
      startX,
      60,
      R,
      {
        restitution: 0.5,
        friction: 0.005,
        frictionAir: 0.001,
        label: 'marble_' + m.id
      }
    );

    Body.setVelocity(body, {
      x: (rand() - 0.5) * 4,
      y: 2
    });

    World.add(engine.world, body);

    marbleBodies.push({
      id: m.id,
      body
    });
  });

  physicsLoop = setInterval(() => {

    Engine.update(engine, TICK_MS);

    // anti stuck
    marbleBodies.forEach(({ body }) => {

      const speed =
        Math.abs(body.velocity.x) +
        Math.abs(body.velocity.y);

      if (speed < 0.15) {

        Body.applyForce(body, body.position, {
          x: (Math.random() - 0.5) * 0.015,
          y: 0.02
        });
      }
    });

    tickCount++;

    if (tickCount % EMIT_EVERY !== 0) return;

    const positions = marbleBodies.map(
      ({ id, body }) => ({
        id,
        x: body.position.x,
        y: body.position.y,
        angle: body.angle
      })
    );

    io.emit('positions', positions);

    if (marbleBodies.length) {

      const leader = marbleBodies.reduce(
        (a, b) =>
          a.body.position.y >
          b.body.position.y
            ? a
            : b
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

  gameState.phase = 'results';

  io.emit('raceWinner', {
    winnerId
  });

  setTimeout(() => {

    destroyRace();

  }, 4000);
}

function destroyRace() {

  clearInterval(physicsLoop);

  physicsLoop = null;

  if (engine) {

    World.clear(engine.world);

    Engine.clear(engine);
  }

  marbleBodies = [];
  engine = null;
}

io.on('connection', socket => {

  socket.emit('stateUpdate', gameState);

  socket.on('setMarbles', marbles => {

    gameState.marbles = marbles;

    io.emit('stateUpdate', gameState);
  });

  socket.on('startRace', () => {

    if (!gameState.marbles.length) return;

    gameState.phase = 'racing';
    gameState.seed  = Date.now();

    startPhysics();

    io.emit('trackData', gameState.trackBodies);

    io.emit('stateUpdate', gameState);
  });

  socket.on('resetRace', () => {

    destroyRace();

    gameState.phase = 'ready';
    gameState.currentLeader = null;
    gameState.trackBodies = [];

    io.emit('raceReset');

    io.emit('stateUpdate', gameState);
  });

  socket.on('disconnect', () => {
    console.log('desconectado');
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

  console.log('Servidor iniciado en puerto ' + PORT);
});
