const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '10mb' }));

// Game state
let gameState = {
  phase: 'setup',      // setup | lobby | ready | countdown | racing | results
  marbles: [],
  currentLeader: null,
  round: 1,
  scores: {},
  seed: null
};

// Broadcast full state to all clients
function broadcastState() {
  io.emit('stateUpdate', gameState);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new connection
  socket.emit('stateUpdate', gameState);

  // HOST: update marbles list
  socket.on('setMarbles', (marbles) => {
    gameState.marbles = marbles;
    gameState.scores = {};
    marbles.forEach(m => {
      if (!gameState.scores[m.id]) gameState.scores[m.id] = 0;
    });
    broadcastState();
  });

  // HOST: transition phases
  socket.on('setPhase', (phase) => {
    gameState.phase = phase;
    if (phase === 'racing') {
      gameState.seed = Math.floor(Math.random() * 999999);
    }
    broadcastState();
  });

  // HOST: start countdown (server drives it)
  socket.on('startCountdown', () => {
    gameState.phase = 'countdown';
    broadcastState();
    let count = 3;
    const interval = setInterval(() => {
      io.emit('countdownTick', count);
      count--;
      if (count < 0) {
        clearInterval(interval);
        gameState.phase = 'racing';
        gameState.seed = Math.floor(Math.random() * 999999);
        broadcastState();
      }
    }, 1000);
  });

  // GAME: leader update (host sends, everyone receives)
  socket.on('leaderUpdate', (marbleId) => {
    if (gameState.currentLeader !== marbleId) {
      gameState.currentLeader = marbleId;
      io.emit('leaderChanged', marbleId);
    }
  });

  // GAME: winner
  socket.on('raceFinished', (winnerId) => {
    gameState.phase = 'results';
    gameState.currentLeader = null;
    if (gameState.scores[winnerId] !== undefined) {
      gameState.scores[winnerId] += 1;
    }
    io.emit('raceWinner', { winnerId, scores: gameState.scores });
    broadcastState();
  });

  // HOST: next round
  socket.on('nextRound', () => {
    gameState.round += 1;
    gameState.phase = 'ready';
    gameState.currentLeader = null;
    broadcastState();
  });

  // HOST: full reset
  socket.on('resetGame', () => {
    gameState = {
      phase: 'setup',
      marbles: [],
      currentLeader: null,
      round: 1,
      scores: {},
      seed: null
    };
    broadcastState();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Marble Race server running on port ${PORT}`);
});

