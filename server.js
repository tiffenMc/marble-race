const express = require('express');
      }
    });

    broadcastState();
  });

  socket.on('setPhase', phase => {
    gameState.phase = phase;
    broadcastState();
  });

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

        buildRace();

        broadcastState();
      }
    }, 1000);
  });

  socket.on('nextRound', () => {
    destroyRace();

    gameState.round += 1;
    gameState.phase = 'ready';
    gameState.currentLeader = null;

    broadcastState();
  });

  socket.on('resetGame', () => {
    destroyRace();

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
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('Server running on', PORT);
});
