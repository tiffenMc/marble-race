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

const WORLD_W = 800;
const ARENA_H = 600;
const R       = 25;
const TICK_MS = 1000 / 60;

const WEAPONS = [
  { name: 'Maza',     dmg: 18, kb: 8,  range: 35, cd: 1200, icon: '\u{1f528}' },
  { name: 'Martillo', dmg: 15, kb: 7,  range: 30, cd: 1000, icon: '\u{1f528}' },
  { name: 'Espada',   dmg: 12, kb: 4,  range: 40, cd: 800,  icon: '\u{2694}\u{fe0f}' },
  { name: 'Katana',   dmg: 10, kb: 3,  range: 45, cd: 600,  icon: '\u{1f5e1}\u{fe0f}' },
  { name: 'Arco',     dmg: 7,  kb: 2,  range: 80, cd: 1500, icon: '\u{1f3f9}' },
  { name: 'Hacha',    dmg: 14, kb: 6,  range: 35, cd: 1100, icon: '\u{1fa93}' },
  { name: 'Lanza',    dmg: 11, kb: 5,  range: 55, cd: 1300, icon: '\u{1f531}' },
  { name: 'Ballesta', dmg: 9,  kb: 3,  range: 70, cd: 1800, icon: '\u{1f3f9}' },
  { name: 'Cimitarra',dmg: 11, kb: 3,  range: 38, cd: 700,  icon: '\u{1f5e1}\u{fe0f}' },
  { name: 'Alabarda', dmg: 13, kb: 6,  range: 50, cd: 1400, icon: '\u{2694}\u{fe0f}' },
  { name: 'Hoz',      dmg: 8,  kb: 2,  range: 30, cd: 500,  icon: '\u{1f5e1}\u{fe0f}' },
  { name: 'Mandoble', dmg: 16, kb: 5,  range: 42, cd: 1300, icon: '\u{2694}\u{fe0f}' },
  { name: 'Pico',     dmg: 10, kb: 4,  range: 32, cd: 900,  icon: '\u{26cf}\u{fe0f}' },
  { name: 'Vara',     dmg: 6,  kb: 3,  range: 60, cd: 700,  icon: '\u{1fa84}' },
  { name: 'Pu\u00f1os',     dmg: 4,  kb: 1,  range: 20, cd: 300,  icon: '\u{1f44a}' },
  { name: 'Patada',   dmg: 6,  kb: 4,  range: 25, cd: 500,  icon: '\u{1f9b6}' },
  { name: 'Escudo',   dmg: 3,  kb: 6,  range: 22, cd: 600,  icon: '\u{1f6e1}\u{fe0f}' },
  { name: 'Honda',    dmg: 5,  kb: 1,  range: 75, cd: 1000, icon: '\u{1f300}' },
  { name: 'Daga',     dmg: 7,  kb: 2,  range: 25, cd: 400,  icon: '\u{1f5e1}\u{fe0f}' },
  { name: 'Bast\u00f3n',  dmg: 9,  kb: 5,  range: 45, cd: 1000, icon: '\u{1fa86}' },
];

let gameState = {
  phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null
};

let engine       = null;
let gladiators   = [];
let battleLoop   = null;
let tickCount    = 0;

function broadcastState() {
  io.emit('stateUpdate', {
    phase: gameState.phase, marbles: gameState.marbles,
    round: gameState.round, scores: gameState.scores,
    winnerId: gameState.winnerId
  });
}

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function startBattle() {
  destroyBattle();
  tickCount = 0;
  gameState.phase = 'racing';
  gameState.winnerId = null;

  engine = Engine.create({ gravity: { x: 0, y: 0 } });

  const wallOpts = { isStatic: true, restitution: 0.4, friction: 0.1 };
  World.add(engine.world, [
    Bodies.rectangle(WORLD_W / 2, -10, WORLD_W, 20, wallOpts),
    Bodies.rectangle(WORLD_W / 2, ARENA_H + 10, WORLD_W, 20, wallOpts),
    Bodies.rectangle(-10, ARENA_H / 2, 20, ARENA_H, wallOpts),
    Bodies.rectangle(WORLD_W + 10, ARENA_H / 2, 20, ARENA_H, wallOpts),
  ]);

  const rand = seededRandom(Date.now());
  const count = gameState.marbles.length;
  gladiators = [];

  gameState.marbles.forEach((m, i) => {
    const angle = (i / count) * Math.PI * 2;
    const dist = 120 + rand() * 60;
    const cx = WORLD_W / 2 + Math.cos(angle) * dist;
    const cy = ARENA_H / 2 + Math.sin(angle) * dist;

    const body = Bodies.circle(cx, cy, R, {
      restitution: 0.3, friction: 0.15, frictionAir: 0.015,
      label: 'g_' + m.id
    });
    World.add(engine.world, body);

    const wp = WEAPONS[Math.floor(rand() * WEAPONS.length)];

    gladiators.push({
      id: m.id, name: m.name, color: m.color,
      image: m.image, sound: m.sound,
      hp: 100, maxHp: 100, weapon: wp,
      body, lastAttack: 0, alive: true,
      attackAnim: 0
    });
  });

  broadcastState();
  battleLoop = setInterval(tick, TICK_MS);
}

function tick() {
  const now = Date.now();

  gladiators.forEach(g => {
    if (!g.alive) return;

    let nearest = null;
    let minDist = Infinity;

    gladiators.forEach(other => {
      if (other.id === g.id || !other.alive) return;
      const dx = other.body.position.x - g.body.position.x;
      const dy = other.body.position.y - g.body.position.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) { minDist = d; nearest = other; }
    });

    if (!nearest) return;

    const dx = nearest.body.position.x - g.body.position.x;
    const dy = nearest.body.position.y - g.body.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const moveF = 0.004;
    Body.applyForce(g.body, g.body.position, {
      x: (dx / dist) * moveF,
      y: (dy / dist) * moveF
    });

    if (dist < g.weapon.range + R && now - g.lastAttack > g.weapon.cd) {
      g.lastAttack = now;
      g.attackAnim = 300;

      const dmg = g.weapon.dmg + Math.floor(Math.random() * 5) - 2;
      nearest.hp = Math.max(0, nearest.hp - dmg);

      const kb = g.weapon.kb * 1.5;
      Body.setVelocity(nearest.body, {
        x: nearest.body.velocity.x + (dx / dist) * kb,
        y: nearest.body.velocity.y + (dy / dist) * kb
      });

      if (nearest.hp <= 0) {
        nearest.hp = 0;
        nearest.alive = false;
        World.remove(engine.world, nearest.body);
      }
    }

    if (g.attackAnim > 0) g.attackAnim -= TICK_MS;
  });

  const alive = gladiators.filter(g => g.alive);
  if (alive.length <= 1 && gladiators.length > 1) {
    endBattle(alive.length === 1 ? alive[0] : null);
    return;
  }
  if (gladiators.length === 0) return;

  Engine.update(engine, TICK_MS);
  tickCount++;
  if (tickCount % 2 !== 0) return;

  const state = gladiators.map(g => ({
    id: g.id, x: g.body.position.x, y: g.body.position.y,
    hp: g.hp, maxHp: g.maxHp, alive: g.alive,
    weapon: g.weapon, attacking: now - g.lastAttack < 200
  }));

  io.emit('battleState', state);
}

function endBattle(winner) {
  clearInterval(battleLoop);
  battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); }
  engine = null;

  if (winner) {
    gameState.winnerId = winner.id;
    if (!gameState.scores[winner.id]) gameState.scores[winner.id] = 0;
    gameState.scores[winner.id]++;
  }

  gladiators = [];
  gameState.phase = 'results';
  broadcastState();
  io.emit('battleWinner', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : 'Nadie',
    winnerSound: winner ? winner.sound : null,
    scores: gameState.scores
  });
}

function destroyBattle() {
  clearInterval(battleLoop);
  battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); }
  engine = null;
  gladiators = [];
}

io.on('connection', socket => {
  console.log('Conectado:', socket.id);
  socket.emit('stateUpdate', gameState);

  socket.on('setMarbles', data => {
    gameState.marbles = data.map(m => ({
      id: m.id, name: m.name, color: m.color,
      image: m.image || null, sound: m.sound || null, soundName: m.soundName || ''
    }));
    data.forEach(m => { if (gameState.scores[m.id] === undefined) gameState.scores[m.id] = 0; });
    broadcastState();
  });

  socket.on('setPhase', p => { gameState.phase = p; broadcastState(); });

  socket.on('startRace', () => {
    if (gameState.marbles.length < 2) return;
    startBattle();
  });

  socket.on('nextRound', () => {
    destroyBattle();
    gameState.round++;
    gameState.phase = 'lobby';
    gameState.winnerId = null;
    broadcastState();
  });

  socket.on('resetRace', () => {
    destroyBattle();
    gameState.phase = 'lobby';
    gameState.winnerId = null;
    broadcastState();
    io.emit('battleReset');
  });

  socket.on('resetGame', () => {
    destroyBattle();
    gameState = { phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null };
    broadcastState();
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
