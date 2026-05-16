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
  { name: 'Maza',      dmg: 18, charge: 2000, cd: 1000, range: 24, speed: 0.0003, icon: '\u{1f528}', type: 'melee', optRange: 20 },
  { name: 'Martillo',  dmg: 15, charge: 1800, cd: 900,  range: 22, speed: 0.00035, icon: '\u{1f528}', type: 'melee', optRange: 18 },
  { name: 'Espad\u00f3n', dmg: 16, charge: 2000, cd: 900,  range: 28, speed: 0.0003,  icon: '\u{2694}\u{fe0f}', type: 'melee', optRange: 25 },
  { name: 'Hacha',     dmg: 14, charge: 1500, cd: 800,  range: 24, speed: 0.0004,  icon: '\u{1fa93}', type: 'melee', optRange: 22 },
  { name: 'Espada',    dmg: 12, charge: 1200, cd: 700,  range: 22, speed: 0.0005,  icon: '\u{2694}\u{fe0f}', type: 'melee', optRange: 20 },
  { name: 'Lanza',     dmg: 10, charge: 1500, cd: 800,  range: 44, speed: 0.0004,  icon: '\u{1f531}', type: 'melee', optRange: 40 },
  { name: 'Katana',    dmg: 9,  charge: 700,  cd: 500,  range: 18, speed: 0.0007,  icon: '\u{1f5e1}\u{fe0f}', type: 'melee', optRange: 16 },
  { name: 'Daga',      dmg: 5,  charge: 400,  cd: 400,  range: 16, speed: 0.0008,  icon: '\u{1f5e1}\u{fe0f}', type: 'melee', optRange: 14 },
  { name: 'Pu\u00f1os', dmg: 3,  charge: 250,  cd: 300,  range: 14, speed: 0.001,   icon: '\u{1f44a}', type: 'melee', optRange: 12 },
  { name: 'Patada',    dmg: 6,  charge: 600,  cd: 500,  range: 20, speed: 0.0007,  icon: '\u{1f9b6}', type: 'melee', optRange: 18 },
  { name: 'Arco',      dmg: 4,  charge: 2000, cd: 1500, range: 100,speed: 0.0004,  icon: '\u{1f3f9}', type: 'ranged', optRange: 110 },
  { name: 'Ballesta',  dmg: 7,  charge: 2400, cd: 1800, range: 85, speed: 0.00035, icon: '\u{1f3f9}', type: 'ranged', optRange: 90 },
  { name: 'Vara',      dmg: 5,  charge: 1600, cd: 1200, range: 60, speed: 0.0005,  icon: '\u{1fa84}', type: 'ranged', optRange: 70 },
  { name: 'Jabalina',  dmg: 8,  charge: 2000, cd: 1400, range: 65, speed: 0.00035, icon: '\u{1f531}', type: 'ranged', optRange: 75 },
  { name: 'Escudo',    dmg: 2,  charge: 800,  cd: 800,  range: 18, speed: 0.0006,  icon: '\u{1f6e1}\u{fe0f}', type: 'melee', optRange: 16 },
  { name: 'L\u00e1tigo', dmg: 5,  charge: 700,  cd: 700,  range: 40, speed: 0.00065, icon: '\u{1f3f9}', type: 'melee', optRange: 36 },
  { name: 'Estrella',  dmg: 3,  charge: 700,  cd: 700,  range: 60, speed: 0.0006,  icon: '\u{2b50}', type: 'ranged', optRange: 65 },
  { name: 'Pico',      dmg: 8,  charge: 1000, cd: 700,  range: 24, speed: 0.0005,  icon: '\u{26cf}\u{fe0f}', type: 'melee', optRange: 22 },
  { name: 'Tridente',  dmg: 10, charge: 1500, cd: 800,  range: 42, speed: 0.00045, icon: '\u{1f531}', type: 'melee', optRange: 38 },
  { name: 'Mayal',     dmg: 13, charge: 1800, cd: 900,  range: 28, speed: 0.00035, icon: '\u{1f528}', type: 'melee', optRange: 25 },
];

const PLATFORMS = [
  { x: W_W / 2, y: 460, w: W_W, h: 30 },
  { x: 150, y: 365, w: 160, h: 12 }, { x: 500, y: 365, w: 180, h: 12 },
  { x: 350, y: 290, w: 200, h: 12 }, { x: 120, y: 290, w: 110, h: 12 }, { x: 620, y: 290, w: 110, h: 12 },
  { x: 400, y: 215, w: 160, h: 12 }, { x: 220, y: 215, w: 100, h: 12 }, { x: 580, y: 215, w: 100, h: 12 },
  { x: 400, y: 145, w: 120, h: 12 },
];

const THEMES = [
  { name: 'Coliseo', bg: ['#0d0a1a','#1a0d1a','#2a1508'], plat: ['#3a2a1a','#2a1a0a'], ac: '#ffcc00' },
  { name: 'Bosque',  bg: ['#0a1a0a','#0d2a0d','#1a3a15'], plat: ['#2a4a1a','#1a3a0a'], ac: '#39ff14' },
  { name: 'Volc\u00e1n',bg: ['#1a0500','#2a0a00','#3a1500'], plat: ['#4a2a0a','#3a1a00'], ac: '#ff4400' },
  { name: 'Hielo',   bg: ['#0a1a2a','#0d2a3a','#1a3a4a'], plat: ['#2a4a5a','#1a3a4a'], ac: '#00ccff' },
];

let gameState = {
  phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null, theme: THEMES[0]
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
    winnerId: gameState.winnerId, theme: gameState.theme
  });
}

function startBattle() {
  destroyBattle();
  tickCount = 0;
  gameState.phase = 'racing';
  gameState.winnerId = null;
  gameState.theme = THEMES[Math.floor(Math.random() * THEMES.length)];

  engine = Engine.create({ gravity: { x: 0, y: 0.5 } });

  World.add(engine.world, [
    Bodies.rectangle(-10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.3, friction: 0.2 }),
    Bodies.rectangle(W_W + 10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.3, friction: 0.2 }),
  ]);

  PLATFORMS.forEach(p => {
    World.add(engine.world, Bodies.rectangle(p.x, p.y, p.w, p.h, {
      isStatic: true, restitution: 0.1, friction: 0.6, label: 'plat'
    }));
  });

  const count = gameState.marbles.length;
  gladiators = [];

  gameState.marbles.forEach((m, i) => {
    const angle = (i / count) * Math.PI * 2;
    const dist = 160 + Math.random() * 80;
    const x = W_W / 2 + Math.cos(angle) * dist;
    const y = 130 + Math.random() * 80;

    const body = Bodies.circle(x, y, 14, {
      restitution: 0.4, friction: 0.2, frictionAir: 0.01,
      density: 0.0015, label: 'g_' + m.id
    });
    World.add(engine.world, body);

    const wp = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];

    gladiators.push({
      id: m.id, name: m.name, color: m.color,
      image: m.image, sound: m.sound,
      hp: 100, maxHp: 100, weapon: wp,
      body, state: 'move', stateTimer: 0, alive: true,
      walkPhase: Math.random() * Math.PI * 2, chargePct: 0,
      flail: 0
    });
  });

  broadcastState();
  battleLoop = setInterval(tick, TICK);
}

function tick() {
  const now = Date.now();

  // Projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life--;
    if (p.life <= 0 || p.body.position.x < -20 || p.body.position.x > W_W + 20 || p.body.position.y > W_H + 20) {
      World.remove(engine.world, p.body); projectiles.splice(i, 1); continue;
    }
    let hit = false;
    gladiators.forEach(g => {
      if (g.id === p.owner || !g.alive || hit) return;
      const dx = g.body.position.x - p.body.position.x;
      const dy = g.body.position.y - p.body.position.y;
      if (dx * dx + dy * dy < 400) {
        g.hp = Math.max(0, g.hp - p.dmg);
        g._lastDmg = p.dmg; g._lastCrit = false;
        Body.setVelocity(g.body, { x: (dx / 20) * 6, y: (dy / 20) * 3 - 3 });
        if (g.hp <= 0) { g.alive = false; World.remove(engine.world, g.body); }
        hit = true;
      }
    });
    if (hit) { try { World.remove(engine.world, p.body); } catch(e) {} projectiles.splice(i, 1); }
  }

  // Gladiators
  gladiators.forEach(g => {
    if (!g.alive) return;
    if (g.flail > 0) g.flail -= TICK * 0.01;

    let nearest = null, minDist = Infinity;
    gladiators.forEach(o => {
      if (o.id === g.id || !o.alive) return;
      const dx = o.body.position.x - g.body.position.x;
      const dy = o.body.position.y - g.body.position.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) { minDist = d; nearest = o; }
    });
    if (!nearest) return;

    const dx = nearest.body.position.x - g.body.position.x;
    const dy = nearest.body.position.y - g.body.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const isR = g.weapon.type === 'ranged';

    // Repulsion
    gladiators.forEach(o => {
      if (o.id === g.id || !o.alive) return;
      const rdx = g.body.position.x - o.body.position.x;
      const rdy = g.body.position.y - o.body.position.y;
      const rd = Math.sqrt(rdx * rdx + rdy * rdy);
      if (rd < 40 && rd > 0) {
        Body.applyForce(g.body, g.body.position, { x: (rdx / rd) * 0.002 * (40 - rd) / 40, y: (rdy / rd) * 0.002 * (40 - rd) / 40 });
      }
    });

    switch (g.state) {
      case 'move':
        if (isR) {
          if (dist < g.weapon.optRange * 0.4) {
            Body.applyForce(g.body, g.body.position, { x: -(dx / dist) * g.weapon.speed * 2, y: 0 });
          } else if (dist > g.weapon.optRange * 1.2) {
            Body.applyForce(g.body, g.body.position, { x: (dx / dist) * g.weapon.speed * 0.5, y: 0 });
          } else {
            g.state = 'charge'; g.stateTimer = 0; g.chargePct = 0;
          }
        } else {
          Body.applyForce(g.body, g.body.position, { x: (dx / dist) * g.weapon.speed, y: 0 });
          if (dist < g.weapon.range + 15) { g.state = 'charge'; g.stateTimer = 0; g.chargePct = 0; }
        }
        break;

      case 'charge':
        g.stateTimer += TICK;
        g.chargePct = Math.min(1, g.stateTimer / g.weapon.charge);
        Body.applyForce(g.body, g.body.position, { x: (dx / dist) * g.weapon.speed * 0.2, y: 0 });

        if (isR) {
          if (dist < g.weapon.optRange * 0.35) { g.state = 'move'; break; }
          if (g.chargePct >= 1 && dist < g.weapon.range + 20) {
            g.lastAttack = now; g.state = 'cooldown'; g.stateTimer = 0;
            const pBody = Bodies.circle(g.body.position.x + (dx / dist) * 18, g.body.position.y - 3, 3,
              { restitution: 0.1, friction: 0, frictionAir: 0.002, density: 0.0002 });
            Body.setVelocity(pBody, { x: (dx / dist) * 5, y: (dy / dist) * 2 });
            World.add(engine.world, pBody);
            projectiles.push({ body: pBody, owner: g.id, dmg: g.weapon.dmg, life: 120 });
          }
        } else {
          if (g.chargePct >= 1 && dist < g.weapon.range + 12) {
            let dmg = g.weapon.dmg + Math.floor(Math.random() * 4) - 1;
            let crit = Math.random() < 0.12;
            if (crit) dmg = Math.floor(dmg * 2);
            nearest.hp = Math.max(0, nearest.hp - dmg);
            nearest._lastDmg = dmg; nearest._lastCrit = crit;
            nearest.flail = 1;
            const kb = 3 + dmg * 0.15;
            Body.setVelocity(nearest.body, { x: (dx / dist) * kb, y: (dy / dist) * kb * 0.3 - kb * 0.15 });
            g.state = 'cooldown'; g.stateTimer = 0;
            if (nearest.hp <= 0) { nearest.alive = false; World.remove(engine.world, nearest.body); }
          }
          if (dist > g.weapon.range + 25) { g.state = 'move'; }
        }
        break;

      case 'cooldown':
        g.stateTimer += TICK;
        Body.applyForce(g.body, g.body.position, { x: -(dx / dist) * g.weapon.speed * 0.5, y: 0 });
        if (g.stateTimer >= g.weapon.cd) { g.state = 'move'; g.chargePct = 0; }
        break;
    }

    const onFloor = g.body.position.y > 430 || PLATFORMS.some(p =>
      Math.abs(g.body.position.x - p.x) < p.w / 2 && Math.abs(g.body.position.y + 14 - p.y) < 5);
    if (onFloor && Math.random() < 0.002) {
      Body.setVelocity(g.body, { x: g.body.velocity.x + (dx / dist) * 0.3, y: -5 });
    }

    g.walkPhase += Math.abs(g.body.velocity.x) * 0.03;
  });

  const alive = gladiators.filter(g => g.alive);
  if (alive.length <= 1 && gladiators.length > 1) {
    endBattle(alive.length === 1 ? alive[0] : null); return;
  }
  if (gladiators.length === 0) return;

  Engine.update(engine, TICK);
  tickCount++;
  if (tickCount % 2 !== 0) return;

  const state = gladiators.map(g => {
    const s = {
      id: g.id, x: g.body.position.x, y: g.body.position.y,
      hp: g.hp, maxHp: g.maxHp, alive: g.alive, weapon: g.weapon,
      state: g.state, chargePct: g.chargePct, walkPhase: g.walkPhase, flail: g.flail
    };
    if (g._lastDmg) { s.dmg = g._lastDmg; s.crit = g._lastCrit; g._lastDmg = 0; g._lastCrit = 0; }
    return s;
  });

  io.emit('battleState', { gladiators: state, projectiles: projectiles.map(p => ({ x: p.body.position.x, y: p.body.position.y })) });
}

function endBattle(winner) {
  clearInterval(battleLoop); battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); } engine = null;
  if (winner) { gameState.winnerId = winner.id; if (!gameState.scores[winner.id]) gameState.scores[winner.id] = 0; gameState.scores[winner.id]++; }
  gladiators = []; projectiles = []; gameState.phase = 'results';
  broadcastState();
  io.emit('battleWinner', { winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : 'Nadie', winnerSound: winner ? winner.sound : null, scores: gameState.scores });
}

function destroyBattle() {
  clearInterval(battleLoop); battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); } engine = null;
  gladiators = []; projectiles = [];
}

io.on('connection', socket => {
  console.log('Conectado:', socket.id);
  socket.emit('stateUpdate', gameState);
  socket.on('setMarbles', data => {
    gameState.marbles = data.map(m => ({ id: m.id, name: m.name, color: m.color, image: m.image || null, sound: m.sound || null, soundName: m.soundName || '' }));
    data.forEach(m => { if (gameState.scores[m.id] === undefined) gameState.scores[m.id] = 0; }); broadcastState();
  });
  socket.on('setPhase', p => { gameState.phase = p; broadcastState(); });
  socket.on('startRace', () => { if (gameState.marbles.length < 2) return; startBattle(); });
  socket.on('nextRound', () => { destroyBattle(); gameState.round++; gameState.phase = 'lobby'; gameState.winnerId = null; broadcastState(); });
  socket.on('resetRace', () => { destroyBattle(); gameState.phase = 'lobby'; gameState.winnerId = null; broadcastState(); io.emit('battleReset'); });
  socket.on('resetGame', () => { destroyBattle(); gameState = { phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null, theme: THEMES[0] }; broadcastState(); });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
