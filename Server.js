/**
 * BrainStorm Royale — Multiplayer Server
 * Socket.io authoritative server
 * Deploy on Railway / Render (NOT Vercel — needs persistent WebSocket)
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3001;
const TICK_RATE  = 20;          // server ticks per second
const TICK_MS    = 1000 / TICK_RATE;

// ─── Game Constants ───────────────────────────────────────────────────────────
const MAP_SIZE      = 2000;
const PLAYER_SIZE   = 30;
const PLAYER_SPEED  = 5;
const BULLET_SPEED  = 14;
const BOT_COUNT     = 10;       // bots per game to fill lobbies
const MIN_PLAYERS   = 2;        // start countdown when this many join
const START_COUNTDOWN = 15;     // seconds before match starts
const MATCH_DURATION  = 300;    // 5 minutes in seconds

const WEAPONS = {
  pistol:   { name:'Pistol',   damage:15, fireRate:400,  ammoUse:1, range:300 },
  shotgun:  { name:'Shotgun',  damage:40, fireRate:800,  ammoUse:2, range:150 },
  rifle:    { name:'Rifle',    damage:25, fireRate:200,  ammoUse:1, range:400 },
  sniper:   { name:'Sniper',   damage:75, fireRate:1500, ammoUse:1, range:600 },
  smg:      { name:'SMG',      damage:10, fireRate:100,  ammoUse:1, range:200 },
  rocket:   { name:'Rocket',   damage:90, fireRate:2000, ammoUse:3, range:500 },
  laser:    { name:'Laser',    damage:20, fireRate:150,  ammoUse:1, range:450 },
  grenade:  { name:'Grenade',  damage:60, fireRate:1200, ammoUse:2, range:350 },
  crossbow: { name:'Crossbow', damage:55, fireRate:900,  ammoUse:1, range:380 },
  minigun:  { name:'Minigun',  damage:8,  fireRate:60,   ammoUse:1, range:280 },
};

const TRIVIA = [
  { q:"What planet is the Red Planet?",         a:["Mars","Venus","Jupiter","Mercury"],   correct:0 },
  { q:"How many sides does a hexagon have?",    a:["5","6","7","8"],                       correct:1 },
  { q:"Largest ocean?",                         a:["Atlantic","Pacific","Indian","Arctic"],correct:1 },
  { q:"Who wrote Romeo and Juliet?",            a:["Dickens","Shakespeare","Twain","Austen"],correct:1 },
  { q:"What is 15 × 8?",                        a:["110","115","120","125"],               correct:2 },
  { q:"What gas do plants absorb?",             a:["Oxygen","Nitrogen","CO2","Hydrogen"],  correct:2 },
  { q:"How many continents?",                   a:["5","6","7","8"],                       correct:2 },
  { q:"Capital of Japan?",                      a:["Seoul","Beijing","Tokyo","Bangkok"],   correct:2 },
  { q:"Fastest animal?",                        a:["Lion","Cheetah","Horse","Falcon"],     correct:1 },
  { q:"WW2 ended in?",                          a:["1943","1944","1945","1946"],           correct:2 },
  { q:"Chemical symbol for water?",             a:["H2O","CO2","NaCl","O2"],              correct:0 },
  { q:"Players on a soccer team?",              a:["9","10","11","12"],                    correct:2 },
  { q:"Largest planet?",                        a:["Saturn","Jupiter","Neptune","Uranus"], correct:1 },
  { q:"Who painted the Mona Lisa?",             a:["Picasso","Da Vinci","Van Gogh","Monet"],correct:1 },
  { q:"What is 144 ÷ 12?",                      a:["10","11","12","14"],                  correct:2 },
];

const POWERUP_EFFECTS = [
  { name:'Shield',    effect:'shield',    value:50  },
  { name:'Speed',     effect:'speed',     value:1.5, duration:8000 },
  { name:'Health',    effect:'health',    value:50  },
  { name:'Ammo',      effect:'ammo',      value:30  },
  { name:'Materials', effect:'materials', value:50  },
];

const BOT_NAMES = ['AceBot','BrainBot','QuizBot','StormBot','NeonBot',
                   'SwiftBot','IronBot','ZenBot','VoidBot','BlitzBot',
                   'CryptoBot','FuryBot','GhostBot','HexBot','Nova'];

// ─── App Setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET','POST'],
    credentials: false,
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  path: '/socket.io',
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// Trust Railway's proxy
app.set('trust proxy', 1);

// Serve the game HTML from same folder
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Health check for Railway/Render
app.get('/health', (req, res) => res.json({ status:'ok', rooms: rooms.size, players: totalConnected() }));

// ─── Room State ───────────────────────────────────────────────────────────────
const rooms = new Map();  // roomId -> RoomState

function totalConnected() {
  let n = 0;
  rooms.forEach(r => { n += Object.keys(r.players).length; });
  return n;
}

function createRoom(roomId, isPublic = true) {
  const lootItems = [];
  for (let i = 0; i < 40; i++) {
    const types = ['weapon','ammo','materials','health'];
    const type  = types[Math.floor(Math.random() * types.length)];
    const allWeps = Object.keys(WEAPONS).filter(w => w !== 'pistol');
    lootItems.push({
      id: 'loot_' + i,
      x:  200 + Math.random() * (MAP_SIZE - 400),
      y:  200 + Math.random() * (MAP_SIZE - 400),
      type,
      weapon: type === 'weapon' ? allWeps[Math.floor(Math.random() * allWeps.length)] : null,
      value:  type === 'ammo' ? 20 : type === 'materials' ? 30 : type === 'health' ? 25 : 0,
    });
  }

  const stations = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    stations.push({
      id: 'ts_' + i,
      x:  MAP_SIZE/2 + Math.cos(angle) * MAP_SIZE * 0.25,
      y:  MAP_SIZE/2 + Math.sin(angle) * MAP_SIZE * 0.25,
      radius: 55,
      used: false,
    });
  }

  return {
    id: roomId,
    isPublic,
    phase:      'waiting',   // waiting | countdown | active | ended
    countdown:  START_COUNTDOWN,
    timeLeft:   MATCH_DURATION,
    players:    {},          // socketId -> PlayerState
    bots:       {},
    bullets:    [],
    loot:       lootItems,
    stations,
    buildings:  [],
    storm: {
      x:      MAP_SIZE / 2,
      y:      MAP_SIZE / 2,
      radius: MAP_SIZE * 0.7,
      targetRadius: MAP_SIZE * 0.08,
      speed:  0.25,
    },
    tickInterval:      null,
    countdownInterval: null,
    lastBulletId:      0,
  };
}

function spawnPosition(taken = []) {
  let x, y, safe;
  let tries = 0;
  do {
    const angle = Math.random() * Math.PI * 2;
    const dist  = MAP_SIZE * 0.25 + Math.random() * MAP_SIZE * 0.2;
    x = MAP_SIZE/2 + Math.cos(angle) * dist;
    y = MAP_SIZE/2 + Math.sin(angle) * dist;
    safe = taken.every(p => Math.hypot(p.x-x, p.y-y) > 120);
    tries++;
  } while (!safe && tries < 30);
  return { x, y };
}

function createPlayer(socketId, username, skin, isBot = false) {
  return {
    id:           socketId,
    username,
    skin:         skin || 'default',
    isBot,
    x: MAP_SIZE/2, y: MAP_SIZE/2,
    vx: 0, vy: 0,
    health:       100,
    shield:       0,
    ammo:         35,
    materials:    50,
    weapons:      ['pistol'],
    currentWeapon:'pistol',
    lastShot:     0,
    speedBoost:   1,
    speedTimer:   0,
    dead:         false,
    kills:        0,
    placement:    0,
    lastSeen:     Date.now(),
    // input from client
    input: { up:false, down:false, left:false, right:false, shooting:false, aimAngle:0, buildMode:false },
  };
}

function addBotsToRoom(room, count) {
  const taken = Object.values(room.players).map(p => ({ x:p.x, y:p.y }));
  const botNames = [...BOT_NAMES].sort(() => Math.random()-0.5).slice(0, count);
  const skins = ['default','bubblegum','mint','ocean','sunset','golden'];
  botNames.forEach((name, i) => {
    const pos    = spawnPosition(taken);
    const botId  = 'bot_' + i + '_' + room.id;
    const weps   = Object.keys(WEAPONS).filter(w => w !== 'pistol');
    const weapon = weps[Math.floor(Math.random() * weps.length)];
    const bot    = createPlayer(botId, name, skins[i % skins.length], true);
    bot.x = pos.x; bot.y = pos.y;
    bot.weapons = ['pistol', weapon];
    bot.currentWeapon = weapon;
    bot.ammo = 999;
    bot._moveTimer  = 0;
    bot._vx = 0; bot._vy = 0;
    bot._targetX = pos.x; bot._targetY = pos.y;
    taken.push(pos);
    room.bots[botId] = bot;
  });
}

// ─── Game Tick ────────────────────────────────────────────────────────────────
function startMatch(room) {
  room.phase = 'active';
  io.to(room.id).emit('matchStart', { loot: room.loot, stations: room.stations });

  // Fill with bots if < 10 real players
  const realCount = Object.keys(room.players).length;
  if (realCount < 10) addBotsToRoom(room, Math.max(0, BOT_COUNT - realCount + 5));

  room.tickInterval = setInterval(() => tickRoom(room), TICK_MS);
}

function tickRoom(room) {
  const now = Date.now();
  const dead = [];

  // ── Storm ────────────────────────────────────────────────────────────────
  if (room.storm.radius > room.storm.targetRadius) {
    room.storm.radius = Math.max(room.storm.targetRadius, room.storm.radius - room.storm.speed * (TICK_MS/1000));
  }
  room.timeLeft -= TICK_MS / 1000;
  if (room.timeLeft <= 0) { endMatch(room, 'time'); return; }

  const allEntities = { ...room.players, ...room.bots };

  // ── Process Players ───────────────────────────────────────────────────────
  Object.values(allEntities).forEach(p => {
    if (p.dead) return;

    if (p.isBot) {
      tickBot(p, room, now);
    } else {
      // Apply client input
      const spd = PLAYER_SPEED * p.speedBoost;
      p.vx = ((p.input.right?1:0) - (p.input.left?1:0)) * spd;
      p.vy = ((p.input.down?1:0)  - (p.input.up?1:0))   * spd;
    }

    p.x = Math.max(PLAYER_SIZE, Math.min(MAP_SIZE - PLAYER_SIZE, p.x + p.vx));
    p.y = Math.max(PLAYER_SIZE, Math.min(MAP_SIZE - PLAYER_SIZE, p.y + p.vy));

    // Speed boost timer
    if (p.speedTimer > 0) { p.speedTimer -= TICK_MS; if (p.speedTimer <= 0) p.speedBoost = 1; }

    // Storm damage
    if (Math.hypot(p.x - room.storm.x, p.y - room.storm.y) > room.storm.radius) {
      p.health -= 0.25 * (TICK_MS / (1000/60));
      if (p.health <= 0) { p.health = 0; killEntity(p, null, room, dead); }
    }

    // Loot pickup (players only)
    if (!p.isBot) {
      room.loot = room.loot.filter(item => {
        if (Math.hypot(p.x - item.x, p.y - item.y) < PLAYER_SIZE + 18) {
          applyLoot(p, item);
          io.to(p.id).emit('lootPickup', { itemId: item.id, player: sanitizePlayer(p) });
          return false;
        }
        return true;
      });
    }

    // Shooting (server-authoritative)
    if (!p.isBot && p.input.shooting) {
      const w = WEAPONS[p.currentWeapon];
      if (w && p.ammo >= w.ammoUse && now - p.lastShot > w.fireRate) {
        fireBullet(p, p.input.aimAngle, room, now);
      }
    }

    // Trivia station proximity
    if (!p.isBot) {
      room.stations.forEach(st => {
        if (!st.used && Math.hypot(p.x - st.x, p.y - st.y) < st.radius + PLAYER_SIZE) {
          if (p.input.interact) {
            st.used = true;
            const q = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
            io.to(p.id).emit('triviaPrompt', { stationId: st.id, question: q });
            p.input.interact = false;
          }
        }
      });
    }
  });

  // ── Move Bullets ─────────────────────────────────────────────────────────
  room.bullets = room.bullets.filter(b => {
    b.x += b.vx; b.y += b.vy;
    b.traveled += Math.hypot(b.vx, b.vy);
    if (b.traveled > b.range || b.x<0 || b.x>MAP_SIZE || b.y<0 || b.y>MAP_SIZE) return false;

    // Check hits against all entities
    for (const target of Object.values(allEntities)) {
      if (target.dead) continue;
      if (target.id === b.ownerId) continue;       // can't shoot self
      if (!target.isBot && b.ownerIsBot === false && target.id !== b.ownerId) {
        // player bullet hits player — friendly fire OFF for same team (future)
      }
      if (Math.hypot(b.x - target.x, b.y - target.y) < PLAYER_SIZE) {
        // Hit!
        let dmg = b.damage;
        if (target.shield > 0) {
          const absorbed = Math.min(target.shield, dmg);
          target.shield -= absorbed;
          dmg -= absorbed;
        }
        target.health -= dmg;
        if (target.health <= 0) {
          target.health = 0;
          killEntity(target, b.ownerId, room, dead);
        }
        return false; // bullet consumed
      }
    }

    // Check building hits
    for (const bld of room.buildings) {
      const cos = Math.cos(-bld.angle), sin = Math.sin(-bld.angle);
      const dx = b.x - bld.x, dy = b.y - bld.y;
      if (Math.abs(dx*cos - dy*sin) < bld.w/2 && Math.abs(dx*sin + dy*cos) < bld.h/2) {
        bld.health -= b.damage;
        if (bld.health <= 0) room.buildings = room.buildings.filter(b2 => b2.id !== bld.id);
        return false;
      }
    }
    return true;
  });

  // ── Check win condition ───────────────────────────────────────────────────
  const alive = Object.values(allEntities).filter(p => !p.dead);
  const alivePlayers = Object.values(room.players).filter(p => !p.dead);
  if (alive.length <= 1 || alivePlayers.length === 0) {
    endMatch(room, 'eliminated');
    return;
  }

  // ── Broadcast state ───────────────────────────────────────────────────────
  const state = buildStateSnapshot(room);
  io.to(room.id).emit('gameState', state);
}

function tickBot(bot, room, now) {
  // Simple bot AI: roam, seek nearest player, shoot
  bot._moveTimer -= TICK_MS;

  const allEntities = { ...room.players, ...room.bots };
  const enemies = Object.values(allEntities).filter(e => !e.dead && e.id !== bot.id && !e.isBot);
  let nearest = null, nearestDist = Infinity;
  enemies.forEach(e => {
    const d = Math.hypot(e.x - bot.x, e.y - bot.y);
    if (d < nearestDist) { nearestDist = d; nearest = e; }
  });

  const w = WEAPONS[bot.currentWeapon] || WEAPONS.pistol;

  if (nearest && nearestDist < w.range * 0.9) {
    // Move toward player
    const angle = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
    bot.vx = Math.cos(angle) * PLAYER_SPEED * 0.7;
    bot.vy = Math.sin(angle) * PLAYER_SPEED * 0.7;
    // Shoot
    if (now - bot.lastShot > w.fireRate * 1.5) {
      const spread = (Math.random() - 0.5) * 0.25; // slight inaccuracy
      fireBullet(bot, angle + spread, room, now, true);
    }
  } else if (bot._moveTimer <= 0) {
    // Wander
    const angle = Math.random() * Math.PI * 2;
    bot._vx = Math.cos(angle) * PLAYER_SPEED * 0.5;
    bot._vy = Math.sin(angle) * PLAYER_SPEED * 0.5;
    bot._moveTimer = 1500 + Math.random() * 2000;
  }

  if (!nearest || nearestDist >= w.range) {
    bot.vx = bot._vx; bot.vy = bot._vy;
  }

  // Storm avoidance
  const distFromCenter = Math.hypot(bot.x - room.storm.x, bot.y - room.storm.y);
  if (distFromCenter > room.storm.radius * 0.85) {
    const angle = Math.atan2(room.storm.y - bot.y, room.storm.x - bot.x);
    bot.vx = Math.cos(angle) * PLAYER_SPEED * 0.9;
    bot.vy = Math.sin(angle) * PLAYER_SPEED * 0.9;
  }
}

function fireBullet(shooter, angle, room, now, fromBot = false) {
  const w = WEAPONS[shooter.currentWeapon] || WEAPONS.pistol;
  shooter.lastShot = now;
  if (!fromBot) shooter.ammo -= w.ammoUse;
  room.lastBulletId++;
  room.bullets.push({
    id:       room.lastBulletId,
    ownerId:  shooter.id,
    ownerIsBot: fromBot,
    x: shooter.x, y: shooter.y,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    damage:   w.damage,
    range:    w.range,
    traveled: 0,
    weapon:   shooter.currentWeapon,
  });
}

function applyLoot(player, item) {
  if (item.type === 'weapon' && item.weapon && !player.weapons.includes(item.weapon)) {
    player.weapons.push(item.weapon);
  } else if (item.type === 'ammo')      { player.ammo      = Math.min(999, player.ammo + item.value); }
  else if (item.type === 'materials')   { player.materials = Math.min(999, player.materials + item.value); }
  else if (item.type === 'health')      { player.health    = Math.min(100, player.health + item.value); }
}

function applyTriviaReward(player) {
  const reward = POWERUP_EFFECTS[Math.floor(Math.random() * POWERUP_EFFECTS.length)];
  switch (reward.effect) {
    case 'shield':    player.shield    = Math.min(100, player.shield + reward.value); break;
    case 'health':    player.health    = Math.min(100, player.health + reward.value); break;
    case 'ammo':      player.ammo     += reward.value; break;
    case 'materials': player.materials += reward.value; break;
    case 'speed':
      player.speedBoost = reward.value;
      player.speedTimer = reward.duration;
      break;
  }
  return reward;
}

function killEntity(entity, killerId, room, dead) {
  entity.dead = true;
  entity.placement = Object.values({ ...room.players, ...room.bots }).filter(p => p.dead).length;
  dead.push(entity.id);

  // Credit killer
  if (killerId) {
    const killer = room.players[killerId] || room.bots[killerId];
    if (killer) {
      killer.kills++;
      if (!killer.isBot) io.to(killer.id).emit('killConfirmed', { victim: entity.username, kills: killer.kills });
    }
  }

  if (!entity.isBot) {
    io.to(entity.id).emit('youDied', {
      placement: entity.placement,
      kills:     entity.kills,
      killedBy:  killerId ? (room.players[killerId]?.username || room.bots[killerId]?.username || 'Storm') : 'Storm',
    });
  }

  io.to(room.id).emit('playerDied', { id: entity.id, username: entity.username, placement: entity.placement });
}

function endMatch(room, reason) {
  if (room.phase === 'ended') return;
  room.phase = 'ended';
  clearInterval(room.tickInterval);
  clearInterval(room.countdownInterval);

  const allEntities = { ...room.players, ...room.bots };
  const survivors = Object.values(allEntities).filter(p => !p.dead);
  const winner = survivors[0];

  // Award final placements
  Object.values(room.players).forEach(p => {
    if (!p.dead) p.placement = 1;
    io.to(p.id).emit('matchEnd', {
      placement:   p.placement || 1,
      kills:       p.kills,
      winner:      winner?.username || 'Nobody',
      winnerId:    winner?.id,
      coinsEarned: p.kills * 50 + (p.placement === 1 ? 250 : 0),
      xpEarned:    p.kills * 25 + (p.placement === 1 ? 120 : 15),
    });
  });

  // Clean up after 30s
  setTimeout(() => rooms.delete(room.id), 30000);
}

function sanitizePlayer(p) {
  return {
    id: p.id, username: p.username, skin: p.skin, isBot: p.isBot,
    x: Math.round(p.x), y: Math.round(p.y),
    health: Math.round(p.health), shield: Math.round(p.shield),
    ammo: p.ammo, materials: p.materials,
    weapons: p.weapons, currentWeapon: p.currentWeapon,
    dead: p.dead, kills: p.kills,
    aimAngle: p.input?.aimAngle || 0,
  };
}

function buildStateSnapshot(room) {
  return {
    players:  Object.values(room.players).map(sanitizePlayer),
    bots:     Object.values(room.bots).map(sanitizePlayer),
    bullets:  room.bullets.map(b => ({ id:b.id, x:Math.round(b.x), y:Math.round(b.y), weapon:b.weapon, ownerId:b.ownerId })),
    loot:     room.loot.map(l => ({ id:l.id, x:Math.round(l.x), y:Math.round(l.y), type:l.type, weapon:l.weapon })),
    buildings:room.buildings,
    storm:    { x:room.storm.x, y:room.storm.y, radius:Math.round(room.storm.radius) },
    timeLeft: Math.round(room.timeLeft),
    alive:    Object.values({...room.players,...room.bots}).filter(p=>!p.dead).length,
  };
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────
function findOrCreatePublicRoom() {
  for (const [id, room] of rooms) {
    if (room.isPublic && room.phase === 'waiting' && Object.keys(room.players).length < 20) {
      return room;
    }
  }
  const id   = 'pub_' + uuidv4().slice(0,8);
  const room = createRoom(id, true);
  rooms.set(id, room);
  return room;
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connected:', socket.id);
  let playerRoom = null;

  // ── Join matchmaking ──────────────────────────────────────────────────────
  socket.on('joinGame', ({ username, skin, roomCode }) => {
    let room;
    if (roomCode) {
      // Private room code
      const rid = 'priv_' + roomCode.toUpperCase();
      if (!rooms.has(rid)) { rooms.set(rid, createRoom(rid, false)); }
      room = rooms.get(rid);
      if (room.phase !== 'waiting') return socket.emit('error', { msg: 'That room already started.' });
    } else {
      room = findOrCreatePublicRoom();
    }

    playerRoom = room;
    const taken = Object.values(room.players).map(p => ({ x:p.x, y:p.y }));
    const pos   = spawnPosition(taken);
    const player = createPlayer(socket.id, username || 'Player', skin || 'default');
    player.x = pos.x; player.y = pos.y;
    room.players[socket.id] = player;

    socket.join(room.id);
    socket.emit('joinedRoom', {
      roomId:   room.id,
      playerId: socket.id,
      phase:    room.phase,
      players:  Object.values(room.players).map(sanitizePlayer),
      loot:     room.loot,
      stations: room.stations,
    });

    io.to(room.id).emit('playerJoined', sanitizePlayer(player));
    console.log(`  ${username} joined room ${room.id} (${Object.keys(room.players).length} players)`);

    // Start countdown when MIN_PLAYERS reached
    if (Object.keys(room.players).length >= MIN_PLAYERS && room.phase === 'waiting') {
      room.phase = 'countdown';
      room.countdown = START_COUNTDOWN;
      io.to(room.id).emit('countdownStart', { seconds: room.countdown });

      room.countdownInterval = setInterval(() => {
        room.countdown--;
        io.to(room.id).emit('countdown', { seconds: room.countdown });
        if (room.countdown <= 0) {
          clearInterval(room.countdownInterval);
          startMatch(room);
        }
      }, 1000);
    }
  });

  // ── Player input (sent ~20x/s from client) ────────────────────────────────
  socket.on('input', (input) => {
    const room = playerRoom;
    if (!room || room.phase !== 'active') return;
    const p = room.players[socket.id];
    if (!p || p.dead) return;
    p.input   = { ...p.input, ...input };
    p.lastSeen = Date.now();
  });

  // ── Weapon switch ─────────────────────────────────────────────────────────
  socket.on('switchWeapon', ({ weapon }) => {
    const room = playerRoom;
    if (!room || room.phase !== 'active') return;
    const p = room.players[socket.id];
    if (!p || p.dead || !p.weapons.includes(weapon)) return;
    p.currentWeapon = weapon;
  });

  // ── Build ─────────────────────────────────────────────────────────────────
  socket.on('build', ({ angle }) => {
    const room = playerRoom;
    if (!room || room.phase !== 'active') return;
    const p = room.players[socket.id];
    if (!p || p.dead || p.materials < 10) return;
    p.materials -= 10;
    const bldId = 'bld_' + Date.now() + '_' + socket.id;
    room.buildings.push({
      id: bldId,
      x:  p.x + Math.cos(angle) * 65,
      y:  p.y + Math.sin(angle) * 65,
      w:  65, h: 16, angle,
      health: 120,
    });
    io.to(room.id).emit('buildPlaced', { building: room.buildings[room.buildings.length-1] });
  });

  // ── Trivia answer ─────────────────────────────────────────────────────────
  socket.on('triviaAnswer', ({ stationId, answerIndex, question }) => {
    const room = playerRoom;
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || p.dead) return;

    const correct = answerIndex === question.correct;
    let reward = null;
    if (correct) { reward = applyTriviaReward(p); }
    socket.emit('triviaResult', { correct, reward, player: sanitizePlayer(p) });
  });

  // ── Emote ─────────────────────────────────────────────────────────────────
  socket.on('emote', ({ emoji }) => {
    if (!playerRoom) return;
    io.to(playerRoom.id).emit('playerEmote', { playerId: socket.id, emoji });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('- disconnected:', socket.id);
    const room = playerRoom;
    if (!room) return;
    const p = room.players[socket.id];
    if (p && !p.dead) {
      killEntity(p, null, room, []);
    }
    delete room.players[socket.id];
    io.to(room.id).emit('playerLeft', { id: socket.id });

    // Clean up empty rooms
    if (Object.keys(room.players).length === 0 && room.phase !== 'active') {
      clearInterval(room.tickInterval);
      clearInterval(room.countdownInterval);
      rooms.delete(room.id);
    }
  });

  // ── Ping ─────────────────────────────────────────────────────────────────
  socket.on('ping', (cb) => { if (typeof cb === 'function') cb(Date.now()); });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`\n🧠 BrainStorm Royale server running on :${PORT}\n`));