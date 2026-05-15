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

const W_W    = 800;
const W_H    = 500;
const TICK   = 1000 / 60;

const WEAPONS = [
  { name: 'Maza Pesada',      dmg: 30, kb: 12, range: 26, cd: 4200, speed: 0.0007, icon: '\u{1f528}', type: 'melee' },
  { name: 'Martillo Guerra',  dmg: 25, kb: 10, range: 24, cd: 3700, speed: 0.0009, icon: '\u{1f528}', type: 'melee' },
  { name: 'Espad\u00f3n',       dmg: 28, kb: 9,  range: 34, cd: 4000, speed: 0.0008, icon: '\u{2694}\u{fe0f}', type: 'melee' },
  { name: 'Alabarda',         dmg: 22, kb: 8,  range: 48, cd: 3600, speed: 0.001,  icon: '\u{2694}\u{fe0f}', type: 'melee' },
  { name: 'Hacha Batalla',    dmg: 24, kb: 7,  range: 28, cd: 3400, speed: 0.0011, icon: '\u{1fa93}', type: 'melee' },
  { name: 'Espada Larga',     dmg: 18, kb: 6,  range: 24, cd: 3000, speed: 0.0016, icon: '\u{2694}\u{fe0f}', type: 'melee' },
  { name: 'Lanza',            dmg: 15, kb: 5,  range: 50, cd: 3200, speed: 0.0013, icon: '\u{1f531}', type: 'melee' },
  { name: 'Lancero',          dmg: 10, kb: 4,  range: 65, cd: 3400, speed: 0.001,  icon: '\u{1f531}', type: 'melee' },
  { name: 'Bast\u00f3n',        dmg: 14, kb: 6,  range: 42, cd: 2800, speed: 0.0018, icon: '\u{1fa86}', type: 'melee' },
  { name: 'Cimitarra',        dmg: 16, kb: 5,  range: 26, cd: 2600, speed: 0.002,  icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Katana',           dmg: 12, kb: 4,  range: 20, cd: 2000, speed: 0.0026, icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Daga',             dmg: 8,  kb: 2,  range: 18, cd: 1600, speed: 0.003,  icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Hoz',              dmg: 10, kb: 3,  range: 22, cd: 1800, speed: 0.0028, icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Pu\u00f1os',        dmg: 5,  kb: 1,  range: 16, cd: 1200, speed: 0.0035, icon: '\u{1f44a}', type: 'melee' },
  { name: 'Patada',           dmg: 8,  kb: 6,  range: 22, cd: 2200, speed: 0.0028, icon: '\u{1f9b6}', type: 'melee' },
  { name: 'Arco Largo',       dmg: 6,  kb: 2,  range: 100,cd: 3800, speed: 0.0013, icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'Ballesta',         dmg: 10, kb: 3,  range: 85, cd: 4200, speed: 0.001,  icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'Honda',            dmg: 4,  kb: 1,  range: 90, cd: 3200, speed: 0.0016, icon: '\u{1f300}', type: 'ranged' },
  { name: 'Vara M\u00e1gica',   dmg: 7,  kb: 3,  range: 60, cd: 2700, speed: 0.0018, icon: '\u{1fa84}', type: 'ranged' },
  { name: 'Jabalina',         dmg: 12, kb: 5,  range: 70, cd: 3800, speed: 0.0011, icon: '\u{1f531}', type: 'ranged' },
  { name: 'Escudo',           dmg: 4,  kb: 8,  range: 20, cd: 2400, speed: 0.0022, icon: '\u{1f6e1}\u{fe0f}', type: 'melee' },
  { name: 'Red',              dmg: 3,  kb: 1,  range: 55, cd: 4200, speed: 0.0018, icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'L\u00e1tigo',       dmg: 7,  kb: 4,  range: 45, cd: 2400, speed: 0.0025, icon: '\u{1f3f9}', type: 'melee' },
  { name: 'Hacha Arrojadiza', dmg: 8,  kb: 3,  range: 60, cd: 3000, speed: 0.002,  icon: '\u{1fa93}', type: 'ranged' },
  { name: 'B\u00fameran',      dmg: 5,  kb: 1,  range: 80, cd: 3200, speed: 0.0018, icon: '\u{1fa81}', type: 'ranged' },
  { name: 'Estrella Ninja',   dmg: 6,  kb: 1,  range: 60, cd: 2200, speed: 0.0022, icon: '\u{2b50}', type: 'ranged' },
  { name: 'Soplete Fuego',    dmg: 8,  kb: 3,  range: 40, cd: 3000, speed: 0.0018, icon: '\u{1f525}', type: 'ranged' },
  { name: 'Pico',             dmg: 14, kb: 5,  range: 26, cd: 2800, speed: 0.0018, icon: '\u{26cf}\u{fe0f}', type: 'melee' },
  { name: 'Mayal',            dmg: 20, kb: 8,  range: 32, cd: 3600, speed: 0.0009, icon: '\u{1f528}', type: 'melee' },
  { name: 'Tridente',         dmg: 16, kb: 6,  range: 44, cd: 3200, speed: 0.0014, icon: '\u{1f531}', type: 'melee' },
];

const PLATFORMS = [
  { x: W_W / 2, y: 460, w: W_W,    h: 30 },
  { x: 150,     y: 360, w: 160,    h: 12 },
  { x: 500,     y: 360, w: 180,    h: 12 },
  { x: 350,     y: 280, w: 200,    h: 12 },
  { x: 120,     y: 280, w: 110,    h: 12 },
  { x: 620,     y: 280, w: 110,    h: 12 },
  { x: 400,     y: 200, w: 160,    h: 12 },
  { x: 220,     y: 200, w: 100,    h: 12 },
  { x: 580,     y: 200, w: 100,    h: 12 },
  { x: 400,     y: 130, w: 120,    h: 12 },
];

let gameState = {
  phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null
};

let engine      = null;
let gladiators  = [];
let projectiles = [];
let battleLoop  = null;
let tickCount   = 0;

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

  engine = Engine.create({ gravity: { x: 0, y: 1.2 } });

  const wallOpts = { isStatic: true, restitution: 0.2, friction: 0.3 };
  World.add(engine.world, [
    Bodies.rectangle(-10, W_H / 2, 20, W_H, wallOpts),
    Bodies.rectangle(W_W + 10, W_H / 2, 20, W_H, wallOpts),
  ]);

  PLATFORMS.forEach(p => {
    World.add(engine.world, Bodies.rectangle(p.x, p.y, p.w, p.h, {
      isStatic: true, restitution: 0.05, friction: 0.5, label: 'plat'
    }));
  });

  const rand = seededRandom(Date.now());
  const count = gameState.marbles.length;
  gladiators = [];

  gameState.marbles.forEach((m, i) => {
    const x = 60 + rand() * (W_W - 120);
    const body = Bodies.rectangle(x, 300 + rand() * 100, 8, 24, {
      restitution: 0.05, friction: 0.3, frictionAir: 0.01,
      frictionAngular: 0.06, density: 0.001,
      label: 'g_' + m.id
    });
    World.add(engine.world, body);

    const wp = WEAPONS[Math.floor(rand() * WEAPONS.length)];

    gladiators.push({
      id: m.id, name: m.name, color: m.color,
      image: m.image, sound: m.sound,
      hp: 200, maxHp: 200, weapon: wp,
      body, lastAttack: Date.now(), alive: true,
      walkPhase: rand() * Math.PI * 2
    });
  });

  broadcastState();
  battleLoop = setInterval(tick, TICK);
}

function tick() {
  const now = Date.now();

  // ─── Projectiles ─────────────────────────────────────────────
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life--;
    if (p.life <= 0 || p.body.position.x < -20 || p.body.position.x > W_W + 20 || p.body.position.y > W_H + 20) {
      World.remove(engine.world, p.body);
      projectiles.splice(i, 1);
      continue;
    }

    gladiators.forEach(g => {
      if (g.id === p.owner || !g.alive) return;
      const dx = g.body.position.x - p.body.position.x;
      const dy = g.body.position.y - p.body.position.y;
      if (dx * dx + dy * dy < 400) {
        g.hp = Math.max(0, g.hp - p.dmg);
        const fl = Math.sqrt(dx * dx + dy * dy) || 1;
        Body.setVelocity(g.body, {
          x: g.body.velocity.x + (dx / fl) * 2,
          y: g.body.velocity.y - 1.5
        });
        if (g.hp <= 0) { g.alive = false; World.remove(engine.world, g.body); }
        try { World.remove(engine.world, p.body); } catch(e) {}
        projectiles.splice(i, 1);
      }
    });
  }

  // ─── Gladiators ─────────────────────────────────────────────
  gladiators.forEach(g => {
    if (!g.alive) return;

    let nearest = null;
    let minDist = Infinity;
    gladiators.forEach(other => {
      if (other.id === g.id || !other.alive) return;
      const dx = other.body.position.x - g.body.position.x;
      const dy = other.body.position.y - g.body.position.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) { minDist = d; nearest = other; }
    });
    if (!nearest) return;

    const dx = nearest.body.position.x - g.body.position.x;
    const dy = nearest.body.position.y - g.body.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    // Repulsi\u00f3n entre gladiadores (evita apelotonamiento)
    gladiators.forEach(other => {
      if (other.id === g.id || !other.alive) return;
      const rdx = g.body.position.x - other.body.position.x;
      const rdy = g.body.position.y - other.body.position.y;
      const rd = Math.sqrt(rdx * rdx + rdy * rdy);
      if (rd < 35 && rd > 0) {
        const rep = 0.008 * (35 - rd) / 35;
        Body.applyForce(g.body, g.body.position, { x: (rdx / rd) * rep, y: (rdy / rd) * rep });
      }
    });

    // Walk toward or flee
    const flee = g.hp < g.maxHp * 0.25 && Math.random() < 0.04;
    const moveDir = flee ? -1 : 1;
    Body.applyForce(g.body, g.body.position, {
      x: (dx / dist) * g.weapon.speed * moveDir,
      y: 0
    });
    if (flee) {
      Body.setVelocity(g.body, { x: g.body.velocity.x + (dx / dist) * 0.5, y: g.body.velocity.y - 1 });
    }

    // Jump if enemy is above/below or randomly
    const onGround = g.body.position.y > 420 || PLATFORMS.some(p =>
      Math.abs(g.body.position.x - p.x) < p.w / 2 &&
      Math.abs(g.body.position.y + 12 - p.y) < 6
    );

    if (onGround && (dy < -40 || Math.random() < 0.008)) {
      Body.setVelocity(g.body, {
        x: g.body.velocity.x + (dx / dist) * (flee ? -1 : 1.2),
        y: -7 + Math.random() * -2
      });
    }

    g.walkPhase += Math.abs(g.body.velocity.x) * 0.06;

    // ─── Melee attack ────────────────────────────────────────
    if (g.weapon.type === 'melee' && dist < g.weapon.range + 12 && now - g.lastAttack > g.weapon.cd) {
      g.lastAttack = now;
      const dmg = g.weapon.dmg + Math.floor(Math.random() * 5) - 2;
      nearest.hp = Math.max(0, nearest.hp - dmg);
      Body.setVelocity(nearest.body, {
        x: nearest.body.velocity.x + (dx / dist) * g.weapon.kb,
        y: nearest.body.velocity.y - g.weapon.kb * 0.4
      });
      if (nearest.hp <= 0) { nearest.alive = false; World.remove(engine.world, nearest.body); }
    }

    // ─── Ranged attack ──────────────────────────────────────
    if (g.weapon.type === 'ranged' && dist > 25 && dist < g.weapon.range + 50 && now - g.lastAttack > g.weapon.cd) {
      g.lastAttack = now;
      const pBody = Bodies.circle(g.body.position.x + (dx / dist) * 16, g.body.position.y - 4, 3, {
        restitution: 0.1, friction: 0, frictionAir: 0, density: 0.0003,
        label: 'proj_' + g.id
      });
      Body.setVelocity(pBody, {
        x: (dx / dist) * 7 + g.body.velocity.x * 0.3,
        y: (dy / dist) * 3 - 0.5
      });
      World.add(engine.world, pBody);
      projectiles.push({ body: pBody, owner: g.id, dmg: g.weapon.dmg, life: 100 });
    }
  });

  const alive = gladiators.filter(g => g.alive);
  if (alive.length <= 1 && gladiators.length > 1) {
    endBattle(alive.length === 1 ? alive[0] : null);
    return;
  }
  if (gladiators.length === 0) return;

  Engine.update(engine, TICK);
  tickCount++;
  if (tickCount % 2 !== 0) return;

  const state = gladiators.map(g => ({
    id: g.id, x: g.body.position.x, y: g.body.position.y,
    vx: g.body.velocity.x, hp: g.hp, maxHp: g.maxHp,
    alive: g.alive, weapon: g.weapon,
    attacking: now - g.lastAttack < 250,
    walkPhase: g.walkPhase
  }));

  const projState = projectiles.map(p => ({ x: p.body.position.x, y: p.body.position.y, owner: p.owner }));

  io.emit('battleState', { gladiators: state, projectiles: projState });
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

  gladiators  = [];
  projectiles = [];
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
  gladiators  = [];
  projectiles = [];
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
