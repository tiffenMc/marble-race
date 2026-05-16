const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const Matter  = require('matter-js');
const { Engine, World, Bodies, Body, Constraint, Body: { setVelocity, applyForce } } = Matter;

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
  // Class-based weapons with shield block %
  { name: 'Arquero',   dmg: 3,  charge: 300,  cd: 350,  range: 55, icon: '\u{1f3f9}', type: 'ranged', block: 5,  dodge: 18 },
  { name: 'Guerrero',  dmg: 12, charge: 800,  cd: 700,  range: 30, icon: '\u{2694}\u{fe0f}', type: 'melee', block: 20, dodge: 3 },
  { name: 'Caballero', dmg: 8,  charge: 500,  cd: 500,  range: 28, icon: '\u{1f6e1}\u{fe0f}', type: 'melee', block: 40, dodge: 5 },
  { name: 'Lancero',   dmg: 7,  charge: 450,  cd: 500,  range: 45, icon: '\u{1f531}', type: 'melee', block: 15, dodge: 10 },
  { name: 'Escudero',  dmg: 5,  charge: 400,  cd: 450,  range: 22, icon: '\u{1f6e1}\u{fe0f}', type: 'melee', block: 60, dodge: 3 },
];

const PLATFORMS = [
  // Single flat floor for 1v1 matches
  { x: W_W / 2, y: 460, w: W_W, h: 30 },
];

const THEMES = [
  { name: 'Coliseo', bg: ['#0d0a1a','#1a0d1a','#2a1508'], plat: ['#3a2a1a','#2a1a0a'], ac: '#ffcc00' },
  { name: 'Bosque',  bg: ['#0a1a0a','#0d2a0d','#1a3a15'], plat: ['#2a4a1a','#1a3a0a'], ac: '#39ff14' },
  { name: 'Volc\u00e1n',bg: ['#1a0500','#2a0a00','#3a1500'], plat: ['#4a2a0a','#3a1a00'], ac: '#ff4400' },
  { name: 'Hielo',   bg: ['#0a1a2a','#0d2a3a','#1a3a4a'], plat: ['#2a4a5a','#1a3a4a'], ac: '#00ccff' },
];

let gameState = {
  phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null, theme: THEMES[0],
  tournament: null  // { bracket: [[id1,id2],...], matchIndex: 0, winners: [], championId: null }
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
    winnerId: gameState.winnerId, theme: gameState.theme,
    tournament: gameState.tournament
  });
}

// ─── RAGDOLL SYSTEM ────────────────────────────────────────────────

function createRagdoll(x, y, color, marbleId) {
  const col = { group: -1 };
  const P = (opts) => ({ density: 0.001, friction: 0.5, restitution: 0.05, frictionAir: 0.015, collisionFilter: col, ...opts });

  const parts = {};
  const S_ = 0.6; // scale factor (60% of original)

  // Torso
  parts.torso = Bodies.rectangle(x, y, 12 * S_, 16 * S_, P({ density: 0.0005, label: 't_' + marbleId }));

  // Head
  parts.head = Bodies.circle(x, y - 13 * S_, 5, P({ density: 0.0004, restitution: 0.2, label: 'h_' + marbleId }));

  // Arms
  parts.upperArmL = Bodies.rectangle(x - 10 * S_, y - 5 * S_, 4, 14 * S_, P({ density: 0.0003, label: 'ual_' + marbleId }));
  parts.lowerArmL = Bodies.rectangle(x - 14 * S_, y + 4 * S_, 3, 12 * S_, P({ density: 0.00025, label: 'lal_' + marbleId }));
  parts.upperArmR = Bodies.rectangle(x + 10 * S_, y - 5 * S_, 4, 14 * S_, P({ density: 0.0003, label: 'uar_' + marbleId }));
  parts.lowerArmR = Bodies.rectangle(x + 14 * S_, y + 4 * S_, 3, 12 * S_, P({ density: 0.00025, label: 'lar_' + marbleId }));

  // Legs
  parts.upperLegL = Bodies.rectangle(x - 7 * S_, y + 12 * S_, 7, 12 * S_, P({ density: 0.0025, friction: 0.8, label: 'ull_' + marbleId }));
  parts.lowerLegL = Bodies.rectangle(x - 7 * S_, y + 22 * S_, 6, 10 * S_, P({ density: 0.0022, friction: 0.9, label: 'lll_' + marbleId }));
  parts.upperLegR = Bodies.rectangle(x + 7 * S_, y + 12 * S_, 7, 12 * S_, P({ density: 0.0025, friction: 0.8, label: 'ulr_' + marbleId }));
  parts.lowerLegR = Bodies.rectangle(x + 7 * S_, y + 22 * S_, 6, 10 * S_, P({ density: 0.0022, friction: 0.9, label: 'llr_' + marbleId }));

  // Feet
  parts.footL = Bodies.rectangle(x - 7 * S_, y + 30 * S_, 14 * S_, 4, P({ density: 0.004, friction: 0.99, restitution: 0.01, label: 'fl_' + marbleId }));
  parts.footR = Bodies.rectangle(x + 7 * S_, y + 30 * S_, 14 * S_, 4, P({ density: 0.004, friction: 0.99, restitution: 0.01, label: 'fr_' + marbleId }));

  const allBodies = Object.values(parts);
  World.add(engine.world, allBodies);

  // Joints
  const S_JOINT = 0.88, D_JOINT = 0.45;
  const J = (bA, pA, bB, pB, stiff, damp) => {
    const s = stiff !== undefined ? stiff : S_JOINT;
    const d = damp !== undefined ? damp : D_JOINT;
    const c = Constraint.create({ bodyA: bA, pointA: pA, bodyB: bB, pointB: pB, length: 0, stiffness: s, damping: d });
    c._origS = s; c._origD = d;
    World.add(engine.world, c);
    return c;
  };

  const constraints = [
    J(parts.torso, { x: 0, y: -8 * S_ }, parts.head, { x: 0, y: 5 }),
    J(parts.torso, { x: -8 * S_, y: -5 * S_ }, parts.upperArmL, { x: 0, y: -7 * S_ }),
    J(parts.torso, { x: 8 * S_, y: -5 * S_ }, parts.upperArmR, { x: 0, y: -7 * S_ }),
    J(parts.upperArmL, { x: 0, y: 7 * S_ }, parts.lowerArmL, { x: 0, y: -6 * S_ }, 0.7, 0.4),
    J(parts.upperArmR, { x: 0, y: 7 * S_ }, parts.lowerArmR, { x: 0, y: -6 * S_ }, 0.7, 0.4),
    J(parts.torso, { x: -7 * S_, y: 8 * S_ }, parts.upperLegL, { x: 0, y: -6 * S_ }, 0.97, 0.45),
    J(parts.torso, { x: 7 * S_, y: 8 * S_ }, parts.upperLegR, { x: 0, y: -6 * S_ }, 0.97, 0.45),
    J(parts.upperLegL, { x: 0, y: 6 * S_ }, parts.lowerLegL, { x: 0, y: -5 * S_ }, 0.95, 0.4),
    J(parts.upperLegR, { x: 0, y: 6 * S_ }, parts.lowerLegR, { x: 0, y: -5 * S_ }, 0.95, 0.4),
    J(parts.lowerLegL, { x: 0, y: 5 * S_ }, parts.footL, { x: 0, y: -2 }, 0.95, 0.4),
    J(parts.lowerLegR, { x: 0, y: 5 * S_ }, parts.footR, { x: 0, y: -2 }, 0.95, 0.4),
  ];

  return { parts, constraints };
}

function removeRagdollFromWorld(r) {
  Object.values(r.parts).forEach(b => { try { World.remove(engine.world, b); } catch(e) {} });
}

function getRagdollCenter(r) {
  return { x: r.parts.torso.position.x, y: r.parts.torso.position.y };
}

function getAttackHandPos(r, side) {
  const arm = side === 'left' ? r.parts.lowerArmL : r.parts.lowerArmR;
  return { x: arm.position.x, y: arm.position.y };
}

function applyImpulse(body, point, impulse) {
  Body.setVelocity(body, {
    x: body.velocity.x + impulse.x / body.mass,
    y: body.velocity.y + impulse.y / body.mass
  });
}

// ─── BATTLE ────────────────────────────────────────────────────────

function startBattle(id1, id2) {
  destroyBattle();
  tickCount = 0;
  gameState.phase = 'racing';
  gameState.winnerId = null;
  gameState.theme = THEMES[Math.floor(Math.random() * THEMES.length)];

  engine = Engine.create({ gravity: { x: 0, y: 0.2 } });

  // Walls
  World.add(engine.world, [
    Bodies.rectangle(-10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.2, friction: 0.8 }),
    Bodies.rectangle(W_W + 10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.2, friction: 0.8 }),
  ]);

  // Single floor
  PLATFORMS.forEach(p => {
    World.add(engine.world, Bodies.rectangle(p.x, p.y, p.w, p.h, {
      isStatic: true, restitution: 0.05, friction: 0.9, label: 'plat'
    }));
  });

  gladiators = [];

  // Find the two marbles by id
  const m1 = gameState.marbles.find(m => m.id === id1);
  const m2 = gameState.marbles.find(m => m.id === id2);
  if (!m1 || !m2) return;

  [m1, m2].forEach((m, i) => {
    const x = 150 + i * 500 + Math.random() * 60;
    const y = 430;
    const ragdoll = createRagdoll(x, y, m.color, m.id);
    const wp = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    gladiators.push({
      id: m.id, name: m.name, color: m.color,
      image: m.image, sound: m.sound,
      hp: 80, maxHp: 80, weapon: wp, dodge: wp.dodge,
      ragdoll, state: 'move', stateTimer: 0, alive: true,
      walkPhase: Math.random() * Math.PI * 2, chargePct: 0,
      flail: 0, facingRight: true, combatTimer: 0,
      deadTimer: 0, hitStun: 0
    });
  });

  broadcastState();
  battleLoop = setInterval(tick, TICK);
}

function startTournament() {
  const ids = gameState.marbles.map(m => m.id);
  // Shuffle and pair up
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const bracket = [];
  for (let i = 0; i < shuffled.length - 1; i += 2) {
    bracket.push([shuffled[i], shuffled[i+1]]);
  }
  // If odd number, last gets a bye (auto-advance)
  if (shuffled.length % 2 !== 0) {
    // Give bye to last player by adding them as already in winners
    gameState.tournament = { bracket, matchIndex: 0, winners: [shuffled[shuffled.length-1]], championId: null };
  } else {
    gameState.tournament = { bracket, matchIndex: 0, winners: [], championId: null };
  }
  // Start first match
  playNextMatch();
}

function playNextMatch() {
  const t = gameState.tournament;
  if (!t) return;
  // If all matches played, check if we need another round
  if (t.matchIndex >= t.bracket.length) {
    // All matches of this round done - check if we have a champion
    if (t.winners.length === 1) {
      // Champion!
      const champ = t.winners[0];
      gameState.winnerId = champ;
      if (!gameState.scores[champ]) gameState.scores[champ] = 0;
      gameState.scores[champ]++;
      gameState.tournament.championId = champ;
      gameState.phase = 'results';
      broadcastState();
      const winnerMarble = gameState.marbles.find(m => m.id === champ);
      io.emit('battleWinner', { winnerId: champ, winnerName: winnerMarble ? winnerMarble.name : 'Nadie', winnerSound: winnerMarble ? winnerMarble.sound : null, scores: gameState.scores });
      return;
    }
    // More than 1 winner - create next round bracket
    const nextBracket = [];
    for (let i = 0; i < t.winners.length - 1; i += 2) {
      nextBracket.push([t.winners[i], t.winners[i+1]]);
    }
    if (t.winners.length % 2 !== 0) {
      gameState.tournament = { bracket: nextBracket, matchIndex: 0, winners: [t.winners[t.winners.length-1]], championId: null };
    } else {
      gameState.tournament = { bracket: nextBracket, matchIndex: 0, winners: [], championId: null };
    }
    playNextMatch();
    return;
  }
  
  const match = t.bracket[t.matchIndex];
  gameState.winnerId = null;
  broadcastState();
  startBattle(match[0], match[1]);
}

function tick() {
  const now = Date.now();

  // ── Projectiles ──
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life--;
    if (p.life <= 0 || p.body.position.x < -20 || p.body.position.x > W_W + 20 || p.body.position.y > W_H + 20) {
      World.remove(engine.world, p.body); projectiles.splice(i, 1); continue;
    }
    let hit = false;
    gladiators.forEach(g => {
      if (g.id === p.owner || !g.alive || hit) return;
      // Check all ragdoll parts
      let hitPart = null, minPartDist = 200;
      Object.values(g.ragdoll.parts).forEach(part => {
        const dx = part.position.x - p.body.position.x;
        const dy = part.position.y - p.body.position.y;
        const d = dx * dx + dy * dy;
        if (d < minPartDist) { minPartDist = d; hitPart = part; }
      });
      if (hitPart && minPartDist < 400) {
        const dx = hitPart.position.x - p.body.position.x;
        const dy = hitPart.position.y - p.body.position.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        g.hp = Math.max(0, g.hp - p.dmg);
        g._lastDmg = p.dmg; g._lastCrit = false; g._lastBlock = null;
        g.hitStun = 200 + p.dmg * 5;
        applyImpulse(hitPart, hitPart.position, { x: (dx / d) * 0.05, y: (dy / d) * 0.02 });
        if (g.hp <= 0) { g.alive = false; g.deadTimer = 0; }
        hit = true;
      }
    });
    if (hit) { try { World.remove(engine.world, p.body); } catch(e) {} projectiles.splice(i, 1); }
  }

  // ── Gladiator AI ──
  gladiators.forEach(g => {
    const r = g.ragdoll;
    const torso = r.parts.torso;
    if (!g.alive) {
      g.deadTimer += TICK;
      if (g.deadTimer > 400 && !r._removed) {
        // Remove ragdoll from physics world so body disappears
        r.constraints.forEach(c => { try { World.remove(engine.world, c); } catch(e) {} });
        Object.values(r.parts).forEach(b => { try { World.remove(engine.world, b); } catch(e) {} });
        r._removed = true;
      }
      return;
    }

    // ── Always keep stiffness at maximum ──
    // Body stays rigid - no limp mode on hit
    g.hitStun = Math.max(0, g.hitStun - TICK);
    r.constraints.forEach(c => { c.stiffness = c._origS; c.damping = c._origD; });

    // Find nearest enemy
    let nearest = null, minDist = Infinity;
    gladiators.forEach(o => {
      if (o.id === g.id || !o.alive) return;
      const oc = getRagdollCenter(o.ragdoll);
      const gc = getRagdollCenter(r);
      const dx = oc.x - gc.x;
      const dy = oc.y - gc.y;
      const d = dx * dx + dy * dy;
      if (d < minDist) { minDist = d; nearest = o; }
    });
    if (!nearest || g.hitStun > 300) return;

    const nc = getRagdollCenter(nearest.ragdoll);
    const gc = getRagdollCenter(r);
    const dx = nc.x - gc.x;
    const dy = nc.y - gc.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    g.facingRight = dx > 0;

    // ── PERSONAL SPACE (STRICT - never violated) ──
    const personalSpace = 25;
    const prefDist = personalSpace + 25;
    const hitRange = g.weapon.range + 10;
    
    // Strong repulsion when approaching personal space
    gladiators.forEach(o => {
      if (o.id === g.id || !o.alive) return;
      const oc2 = getRagdollCenter(o.ragdoll);
      const gc2 = getRagdollCenter(r);
      const rdx = gc2.x - oc2.x;
      const rdy = gc2.y - oc2.y;
      const rd = Math.sqrt(rdx * rdx + rdy * rdy);
      if (rd < personalSpace && rd > 0) {
        const repForce = 0.015 * (personalSpace - rd) / personalSpace;
        applyForce(torso, torso.position, { x: (rdx / rd) * repForce, y: 0 });
      }
    });

    // ── SLOW MOVEMENT ──
    const dir = dx > 0 ? 1 : -1;
    const walkForce = 0.003;
    
    let moveForce = 0;
    if (dist < personalSpace * 0.8) {
      moveForce = -walkForce * 2;
    } else if (dist > prefDist) {
      const ratio = Math.min(0.6, (dist - prefDist) / 60);
      moveForce = walkForce * ratio;
    }
    
    if (Math.abs(torso.angle) < 0.8 && Math.abs(moveForce) > 0.0001) {
      applyForce(torso, torso.position, { x: dir * moveForce, y: 0 });
      if (Math.abs(torso.velocity.x) > 0.5) {
        Body.setVelocity(torso, { x: Math.sign(torso.velocity.x) * 0.5, y: torso.velocity.y });
      }
      // Gentle foot oscillation for walking look
      g.walkPhase += 0.015;
      const step = Math.sin(g.walkPhase);
      applyForce(r.parts.footL, r.parts.footL.position, { x: step * 0.0008 * dir, y: 0 });
      applyForce(r.parts.footR, r.parts.footR.position, { x: -step * 0.0008 * dir, y: 0 });
    }


    // Arms held in guard position when idle
    if (!(Math.abs(moveForce) > 0.0005 || g.state === 'charge')) {
      Body.setAngularVelocity(r.parts.upperArmL, 0.003);
      Body.setAngularVelocity(r.parts.upperArmR, -0.003);
    }

    // ── Combat with weapon range ──
    if (g.state === 'move' && dist < 300 && dist > personalSpace * 0.3) {
      g.state = 'charge'; g.stateTimer = 0; g.chargePct = 0;
    }

    // During charge, advance only until personal space boundary
    if (g.state === 'charge' && Math.abs(torso.angle) < 0.6 && dist > personalSpace && dist < 300) {
      applyForce(torso, torso.position, { x: dir * walkForce * 0.3, y: 0 });
    }

    if (g.state === 'charge') {
      g.stateTimer += TICK;
      g.chargePct = Math.min(1, g.stateTimer / g.weapon.charge);
      const sA = g.facingRight ? r.parts.upperArmR : r.parts.upperArmL;
      const sL = g.facingRight ? r.parts.lowerArmR : r.parts.lowerArmL;
      if (g.chargePct < 0.5) {
        // Wind up - pull arm back (big dramatic motion)
        Body.setAngularVelocity(sA, g.facingRight ? 0.02 : -0.02);
        Body.setAngularVelocity(sL, g.facingRight ? 0.03 : -0.03);
      } else {
        // Strike! (fast, powerful swing)
        Body.setAngularVelocity(sA, g.facingRight ? -0.08 : 0.08);
        Body.setAngularVelocity(sL, g.facingRight ? -0.12 : 0.12);
      }
      // HIT CHECK: based on weapon type
      const isRanged = g.weapon.type === 'ranged';
      if (isRanged) {
        // Ranged: fire projectile when charged
        if (g.chargePct >= 0.5 && dist < 300) {
          const pBody = Bodies.circle(torso.position.x + dir * 18, torso.position.y - 3, 3,
            { restitution: 0.1, friction: 0, frictionAir: 0.002, density: 0.0002 });
          Body.setVelocity(pBody, { x: dir * (3 + Math.random()), y: (dy / dist) * 1.2 - 0.3 + Math.random() * 0.5 });
          World.add(engine.world, pBody);
          projectiles.push({ body: pBody, owner: g.id, dmg: g.weapon.dmg, life: 80 });
          g.state = 'cooldown'; g.stateTimer = 0;
        } else if (g.chargePct >= 1) {
          g.state = 'cooldown'; g.stateTimer = 0;
        }
      } else {
        // Melee hit check (must be at similar height)
        if (g.chargePct >= 0.3 && dist < hitRange && Math.abs(dy) < 25) {
          // Dodge check
          if (Math.random() < nearest.dodge / 100) {
            nearest._lastDmg = 0; nearest._lastCrit = false;
            nearest._lastBlock = 'dodge';
          }
          // Shield block check
          else if (Math.random() < nearest.weapon.block / 100) {
            nearest._lastDmg = 0; nearest._lastCrit = false;
            nearest._lastBlock = 'shield';
          }
          // Hit!
          else {
            let dmg = g.weapon.dmg + (Math.random() < 0.5 ? 1 : 0);
            nearest.hp = Math.max(0, nearest.hp - dmg);
            nearest._lastDmg = dmg; nearest._lastCrit = false;
            nearest.hitStun = 150 + dmg * 3;
            const kb = 0.004 + (g.weapon.dmg / 30);
            applyImpulse(nearest.ragdoll.parts.torso, nearest.ragdoll.parts.torso.position, { x: dir * kb, y: 0 });
            if (nearest.hp <= 0) { nearest.alive = false; nearest.deadTimer = 0; }
          }
          g.state = 'cooldown'; g.stateTimer = 0;
        } else if (g.chargePct >= 1) {
          g.state = 'cooldown'; g.stateTimer = 0;
        }
      }
    }

    if (g.state === 'cooldown') {
      g.stateTimer += TICK;
      Body.setAngularVelocity(g.facingRight ? r.parts.upperArmR : r.parts.upperArmL, g.facingRight ? 0.003 : -0.003);
      if (g.stateTimer >= g.weapon.cd) { g.state = 'move'; g.chargePct = 0; }
    }
  });

  // ── Check winner ──
  const alive = gladiators.filter(g => g.alive);
  if (alive.length <= 1 && gladiators.length > 1) {
    endBattle(alive.length === 1 ? alive[0] : null); return;
  }
  if (gladiators.length === 0) return;

  // ── Step physics ──
  Engine.update(engine, TICK);
  
  // ── Lock torso rotation (ALWAYS upright) ──
  gladiators.forEach(g => {
    if (g.alive && g.ragdoll && g.ragdoll.parts && g.ragdoll.parts.torso) {
      Body.setAngle(g.ragdoll.parts.torso, 0);
      Body.setAngularVelocity(g.ragdoll.parts.torso, 0);
    }
  });

  // ── Broadcast state (every other tick) ──
  tickCount++;
  if (tickCount % 2 !== 0) return;

  const state = gladiators.filter(g => g.alive).map(g => {
    const r = g.ragdoll;
    const parts = {};
    Object.keys(r.parts).forEach(k => {
      const b = r.parts[k];
      parts[k] = { x: b.position.x, y: b.position.y, angle: b.angle };
    });
    const s = {
      id: g.id, parts,
      hp: g.hp, maxHp: g.maxHp, alive: g.alive, weapon: g.weapon,
      state: g.state, chargePct: g.chargePct, walkPhase: g.walkPhase, flail: g.flail,
      facingRight: g.facingRight
    };
    if (g._lastDmg !== undefined) { s.dmg = g._lastDmg; s.crit = g._lastCrit; s.block = g._lastBlock; g._lastDmg = undefined; g._lastCrit = false; g._lastBlock = null; }
    return s;
  });

  io.emit('battleState', {
    gladiators: state,
    projectiles: projectiles.map(p => ({ x: p.body.position.x, y: p.body.position.y }))
  });
}

function endBattle(winner) {
  clearInterval(battleLoop); battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); } engine = null;
  gladiators = []; projectiles = [];
  
  if (winner) {
    gameState.winnerId = winner.id;
    // Record tournament winner
    if (gameState.tournament) {
      gameState.tournament.winners.push(winner.id);
      gameState.tournament.matchIndex++;
      // Emit match result
      io.emit('battleWinner', { 
        winnerId: winner.id, 
        winnerName: winner.name, 
        winnerSound: winner.sound, 
        scores: gameState.scores,
        tournament: { matchIndex: gameState.tournament.matchIndex, total: gameState.tournament.bracket.length }
      });
      // After short delay, start next match
      setTimeout(() => {
        playNextMatch();
      }, 2000);
    } else {
      gameState.phase = 'results';
      if (!gameState.scores[winner.id]) gameState.scores[winner.id] = 0;
      gameState.scores[winner.id]++;
      broadcastState();
      io.emit('battleWinner', { winnerId: winner.id, winnerName: winner.name, winnerSound: winner.sound, scores: gameState.scores });
    }
  } else {
    gameState.phase = 'results';
    broadcastState();
  }
}

function destroyBattle() {
  clearInterval(battleLoop); battleLoop = null;
  if (engine) { World.clear(engine.world); Engine.clear(engine); } engine = null;
  gladiators = []; projectiles = [];
}

// ─── SOCKET.IO ─────────────────────────────────────────────────────

io.on('connection', socket => {
  socket.emit('stateUpdate', gameState);
  socket.on('setMarbles', data => {
    gameState.marbles = data.map(m => ({ id: m.id, name: m.name, color: m.color, image: m.image || null, sound: m.sound || null, soundName: m.soundName || '' }));
    data.forEach(m => { if (gameState.scores[m.id] === undefined) gameState.scores[m.id] = 0; }); broadcastState();
  });
  socket.on('setPhase', p => { gameState.phase = p; broadcastState(); });
  socket.on('startRace', () => {
    if (gameState.marbles.length < 2) return;
    startTournament();
  });
  socket.on('nextRound', () => { destroyBattle(); gameState.round++; gameState.phase = 'lobby'; gameState.winnerId = null; gameState.tournament = null; broadcastState(); });
  socket.on('resetRace', () => { destroyBattle(); gameState.phase = 'lobby'; gameState.winnerId = null; gameState.tournament = null; broadcastState(); io.emit('battleReset'); });
  socket.on('resetGame', () => { destroyBattle(); gameState = { phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null, theme: THEMES[0], tournament: null }; broadcastState(); });
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Servidor en puerto ' + PORT));

// HashCode polyfill for string (for collision group uniqueness)
String.prototype.hashCode = function() {
  let hash = 0;
  for (let i = 0; i < this.length; i++) { const c = this.charCodeAt(i); hash = ((hash << 5) - hash) + c; hash |= 0; }
  return hash;
};


