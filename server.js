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
  // Melee
  { name: 'Daga',      dmg: 3,  charge: 250,  cd: 350,  range: 18, speed: 0.0008, icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Espada',    dmg: 7,  charge: 500,  cd: 500,  range: 28, speed: 0.0005,  icon: '\u{2694}\u{fe0f}', type: 'melee' },
  { name: 'Katana',    dmg: 8,  charge: 400,  cd: 450,  range: 26, speed: 0.00055, icon: '\u{1f5e1}\u{fe0f}', type: 'melee' },
  { name: 'Hacha',     dmg: 10, charge: 600,  cd: 600,  range: 30, speed: 0.0004,  icon: '\u{1fa93}', type: 'melee' },
  { name: 'Maza',      dmg: 12, charge: 700,  cd: 700,  range: 32, speed: 0.00035, icon: '\u{1f528}', type: 'melee' },
  { name: 'Espad\u00f3n', dmg: 14, charge: 800,  cd: 800,  range: 36, speed: 0.0003,  icon: '\u{2694}\u{fe0f}', type: 'melee' },
  { name: 'Lanza',     dmg: 9,  charge: 600,  cd: 650,  range: 48, speed: 0.0004,  icon: '\u{1f531}', type: 'melee' },
  { name: 'Martillo',  dmg: 16, charge: 900,  cd: 900,  range: 35, speed: 0.00025, icon: '\u{1f528}', type: 'melee' },
  { name: 'Alabarda',  dmg: 11, charge: 700,  cd: 700,  range: 52, speed: 0.00035, icon: '\u{1f531}', type: 'melee' },
  { name: 'Mayal',     dmg: 13, charge: 750,  cd: 750,  range: 40, speed: 0.0003,  icon: '\u{1f528}', type: 'melee' },
  // Ranged
  { name: 'Arco',      dmg: 6,  charge: 800,  cd: 700,  range: 80, speed: 0.0005,  icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'Ballesta',  dmg: 9,  charge: 1100, cd: 900,  range: 90, speed: 0.0004,  icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'Jabalina',  dmg: 8,  charge: 700,  cd: 800,  range: 70, speed: 0.00045, icon: '\u{1f531}', type: 'ranged' },
  { name: 'Honda',     dmg: 5,  charge: 600,  cd: 600,  range: 75, speed: 0.0006,  icon: '\u{1f3f9}', type: 'ranged' },
  { name: 'Estrella',  dmg: 4,  charge: 400,  cd: 500,  range: 65, speed: 0.0007,  icon: '\u{2b50}', type: 'ranged' },
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

// ─── RAGDOLL SYSTEM ────────────────────────────────────────────────

function createRagdoll(x, y, color, marbleId) {
  const group = -Math.abs(marbleId.hashCode() || Math.random() * 100000 | 0);
  const col = { group: group };
  const P = (opts) => ({ density: 0.0012, friction: 0.6, restitution: 0.08, frictionAir: 0.01, collisionFilter: col, ...opts });

  const parts = {};

  // Torso (main anchor)
  parts.torso = Bodies.rectangle(x, y, 16, 22, P({ label: 't_' + marbleId }));

  // Head
  parts.head = Bodies.circle(x, y - 17, 7, P({ density: 0.0008, restitution: 0.25, label: 'h_' + marbleId }));

  // Arms
  parts.upperArmL = Bodies.rectangle(x - 11, y - 6, 5, 13, P({ density: 0.0006, label: 'ual_' + marbleId }));
  parts.lowerArmL = Bodies.rectangle(x - 15, y + 4, 4, 11, P({ density: 0.0005, label: 'lal_' + marbleId }));
  parts.upperArmR = Bodies.rectangle(x + 11, y - 6, 5, 13, P({ density: 0.0006, label: 'uar_' + marbleId }));
  parts.lowerArmR = Bodies.rectangle(x + 15, y + 4, 4, 11, P({ density: 0.0005, label: 'lar_' + marbleId }));

  // Legs (wider stance for stability)
  parts.upperLegL = Bodies.rectangle(x - 7, y + 16, 7, 14, P({ density: 0.0012, friction: 0.3, label: 'ull_' + marbleId }));
  parts.lowerLegL = Bodies.rectangle(x - 7, y + 28, 6, 12, P({ density: 0.001, friction: 0.4, label: 'lll_' + marbleId }));
  parts.upperLegR = Bodies.rectangle(x + 7, y + 16, 7, 14, P({ density: 0.0012, friction: 0.3, label: 'ulr_' + marbleId }));
  parts.lowerLegR = Bodies.rectangle(x + 7, y + 28, 6, 12, P({ density: 0.001, friction: 0.4, label: 'llr_' + marbleId }));

  const allBodies = Object.values(parts);
  World.add(engine.world, allBodies);

  // Joints (higher stiffness = more stable ragdoll)
  const S = 0.78, D = 0.35;
  const J = (bA, pA, bB, pB, stiff, damp) => {
    const s = stiff !== undefined ? stiff : S;
    const d = damp !== undefined ? damp : D;
    const c = Constraint.create({ bodyA: bA, pointA: pA, bodyB: bB, pointB: pB, length: 0, stiffness: s, damping: d });
    c._origS = s; c._origD = d;
    World.add(engine.world, c);
    return c;
  };

  const constraints = [
    // Neck: torso top -> head bottom
    J(parts.torso, { x: 0, y: -11 }, parts.head, { x: 0, y: 7 }),
    // Shoulders
    J(parts.torso, { x: -9, y: -7 }, parts.upperArmL, { x: 0, y: -6.5 }),
    J(parts.torso, { x: 9, y: -7 }, parts.upperArmR, { x: 0, y: -6.5 }),
    // Elbows
    J(parts.upperArmL, { x: 0, y: 6.5 }, parts.lowerArmL, { x: 0, y: -5.5 }, 0.5, 0.3),
    J(parts.upperArmR, { x: 0, y: 6.5 }, parts.lowerArmR, { x: 0, y: -5.5 }, 0.5, 0.3),
    // Hips
    J(parts.torso, { x: -7, y: 11 }, parts.upperLegL, { x: 0, y: -7 }),
    J(parts.torso, { x: 7, y: 11 }, parts.upperLegR, { x: 0, y: -7 }),
    // Knees
    J(parts.upperLegL, { x: 0, y: 7 }, parts.lowerLegL, { x: 0, y: -6 }, 0.55, 0.3),
    J(parts.upperLegR, { x: 0, y: 7 }, parts.lowerLegR, { x: 0, y: -6 }, 0.55, 0.3),
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

function startBattle() {
  destroyBattle();
  tickCount = 0;
  gameState.phase = 'racing';
  gameState.winnerId = null;
  gameState.theme = THEMES[Math.floor(Math.random() * THEMES.length)];

  engine = Engine.create({ gravity: { x: 0, y: 0.45 } });

  // Walls
  World.add(engine.world, [
    Bodies.rectangle(-10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.2, friction: 0.8 }),
    Bodies.rectangle(W_W + 10, W_H / 2, 20, W_H, { isStatic: true, restitution: 0.2, friction: 0.8 }),
  ]);

  // Platforms (higher friction = better grip)
  PLATFORMS.forEach(p => {
    World.add(engine.world, Bodies.rectangle(p.x, p.y, p.w, p.h, {
      isStatic: true, restitution: 0.05, friction: 0.9, label: 'plat'
    }));
  });

  const count = gameState.marbles.length;
  gladiators = [];

  gameState.marbles.forEach((m, i) => {
    // All spawn on the central top platform together
    const plat = PLATFORMS[3]; // Central platform at x=350, y=290
    const x = plat.x + (Math.random() - 0.5) * 30;
    const y = plat.y - 28;

    const ragdoll = createRagdoll(x, y, m.color, m.id);
    // Todos pelean con puños - combate cuerpo a cuerpo realista
    const wp = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];

    gladiators.push({
      id: m.id, name: m.name, color: m.color,
      image: m.image, sound: m.sound,
      hp: 80, maxHp: 80, weapon: wp,
      ragdoll, state: 'move', stateTimer: 0, alive: true,
      walkPhase: Math.random() * Math.PI * 2, chargePct: 0,
      flail: 0, facingRight: true, combatTimer: 0,
      deadTimer: 0, hitStun: 0
    });
  });

  broadcastState();
  battleLoop = setInterval(tick, TICK);
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
        g._lastDmg = p.dmg; g._lastCrit = false;
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

    // ── Balance: STRONG correction to keep torso upright ──
    // Aggressive balance that fights gravity and knockback
    const balanceStrength = 0.08;
    const targetAV = -torso.angle * balanceStrength;
    Body.setAngularVelocity(torso, torso.angularVelocity + (targetAV - torso.angularVelocity) * 0.6);

    // ── Get up mechanism if fallen ──
    if (Math.abs(torso.angle) > 0.8) {
      // Apply force at top of torso to create righting torque
      const torqueDir = -Math.sign(torso.angle);
      Body.applyForce(torso, { x: torso.position.x, y: torso.position.y - 12 }, { x: torqueDir * 0.003, y: 0 });
      // Nudge upward to help stand
      if (torso.position.y > 350) {
        applyImpulse(torso, torso.position, { x: 0, y: -1.0 });
        // Pull legs up
        applyImpulse(r.parts.upperLegL, r.parts.upperLegL.position, { x: 0, y: -0.5 });
        applyImpulse(r.parts.upperLegR, r.parts.upperLegR.position, { x: 0, y: -0.5 });
      }
    }

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

    // ── Weapon-based distance management ──
    const wpnRange = g.weapon.range;
    const prefDist = wpnRange * 1.5;     // ideal fighting distance
    const minDist_ = wpnRange * 0.5;     // too close, back off
    const hitRange = wpnRange * 2.5;     // max distance for hit
    
    // Repulsion from ALL enemies when within minDist_
    gladiators.forEach(o => {
      if (o.id === g.id || !o.alive) return;
      const oc2 = getRagdollCenter(o.ragdoll);
      const gc2 = getRagdollCenter(r);
      const rdx = gc2.x - oc2.x;
      const rdy = gc2.y - oc2.y;
      const rd = Math.sqrt(rdx * rdx + rdy * rdy);
      if (rd < minDist_ && rd > 0) {
        const repForce = 0.006 * (minDist_ - rd) / minDist_;
        applyForce(torso, torso.position, { x: (rdx / rd) * repForce, y: 0 });
      }
    });

    // Movement: smooth proportional force
    const dir = dx > 0 ? 1 : -1;
    const walkForce = 0.015;
    // Moving away from target direction if dist < minDist_, toward if dist > prefDist
    let moveForce = 0;
    if (dist < minDist_) {
      moveForce = -walkForce * Math.min(1, (minDist_ - dist) / minDist_);
    } else if (dist > prefDist) {
      const ratio = Math.min(2, (dist - prefDist) / 30);
      moveForce = walkForce * ratio;
    }
    // Small constant push to close tiny gaps
    if (Math.abs(moveForce) < 0.002 && dist > prefDist * 0.8 && dist < prefDist * 1.2) {
      moveForce = walkForce * 0.15;
    }
    
    if (Math.abs(torso.angle) < 0.6) {
      applyForce(torso, torso.position, { x: dir * moveForce, y: 0 });
      // Gentle speed cap
      if (Math.abs(torso.velocity.x) > 2.5) {
        Body.setVelocity(torso, { x: Math.sign(torso.velocity.x) * 2.5, y: torso.velocity.y });
      }
      // Walking animation
      if (Math.abs(moveForce) > 0.001) {
        g.walkPhase += 0.02;
        const legP = Math.sin(g.walkPhase) * 0.3;
        applyForce(r.parts.lowerLegL, r.parts.lowerLegL.position, { x: legP * 0.004 * dir, y: 0 });
        applyForce(r.parts.lowerLegR, r.parts.lowerLegR.position, { x: -legP * 0.004 * dir, y: 0 });
        if (Math.random() < 0.004) applyImpulse(torso, torso.position, { x: dir * 0.12, y: -0.4 });
      }
    }

    // ── Arms hold weapon ──
    Body.setAngularVelocity(r.parts.upperArmL, -r.parts.upperArmL.angle * 0.005);
    Body.setAngularVelocity(r.parts.upperArmR, -r.parts.upperArmR.angle * 0.005);

    // ── Combat with weapon range ──
    if (g.state === 'move' && dist < 300) {
      g.state = 'charge'; g.stateTimer = 0; g.chargePct = 0;
    }

    // Gentle advance during charge
    if (g.state === 'charge' && Math.abs(torso.angle) < 0.6 && dist > minDist_) {
      applyForce(torso, torso.position, { x: dir * walkForce * 0.5, y: 0 });
    }

    if (g.state === 'charge') {
      g.stateTimer += TICK;
      g.chargePct = Math.min(1, g.stateTimer / g.weapon.charge);
      const sA = g.facingRight ? r.parts.upperArmR : r.parts.upperArmL;
      const sL = g.facingRight ? r.parts.lowerArmR : r.parts.lowerArmL;
      if (g.chargePct < 0.5) {
        // Wind up - pull arm back
        Body.setAngularVelocity(sA, g.facingRight ? 0.008 : -0.008);
        Body.setAngularVelocity(sL, g.facingRight ? 0.012 : -0.012);
      } else {
        // Strike!
        Body.setAngularVelocity(sA, g.facingRight ? -0.03 : 0.03);
        Body.setAngularVelocity(sL, g.facingRight ? -0.045 : 0.045);
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
        // Melee hit check
        if (g.chargePct >= 0.3 && dist < hitRange) {
          let dmg = g.weapon.dmg + (Math.random() < 0.5 ? 1 : 0);
          nearest.hp = Math.max(0, nearest.hp - dmg);
          nearest._lastDmg = dmg; nearest._lastCrit = false;
          nearest.hitStun = 150 + dmg * 3;
          const kb = 0.004 + (g.weapon.dmg / 20);
          applyImpulse(nearest.ragdoll.parts.torso, nearest.ragdoll.parts.torso.position, { x: dir * kb, y: -kb * 0.08 });
          applyImpulse(torso, torso.position, { x: -dir * kb * 0.1, y: 0 });
          if (nearest.hp <= 0) { nearest.alive = false; nearest.deadTimer = 0; }
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
    if (g._lastDmg) { s.dmg = g._lastDmg; s.crit = g._lastCrit; g._lastDmg = 0; g._lastCrit = 0; }
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
    gameState.phase = 'racing';
    broadcastState();
    startBattle();
  });
  socket.on('nextRound', () => { destroyBattle(); gameState.round++; gameState.phase = 'lobby'; gameState.winnerId = null; broadcastState(); });
  socket.on('resetRace', () => { destroyBattle(); gameState.phase = 'lobby'; gameState.winnerId = null; broadcastState(); io.emit('battleReset'); });
  socket.on('resetGame', () => { destroyBattle(); gameState = { phase: 'setup', marbles: [], round: 1, scores: {}, winnerId: null, theme: THEMES[0] }; broadcastState(); });
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


