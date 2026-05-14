const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Matter = require('matter-js');

const Engine = Matter.Engine;
const World = Matter.World;
const Bodies = Matter.Bodies;
const Body = Matter.Body;
const Runner = Matter.Runner;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

let gameState = {
  phase: 'setup',
  marbles: [],
  currentLeader: null,
  round: 1,
  scores: {},
  seed: null
};

let engine = null;
let runner = null;
let marbleBodies = [];
let raceLoop = null;
let raceFinished = false;

const WORLD_W = 1200;
const TRACK_HEIGHT = 7000;
const FINISH_Y = TRACK_HEIGHT - 120;
const R = 22;

function broadcastState() {
  io.emit('stateUpdate', gameState);
}

function destroyRace() {
  if (raceLoop) clearInterval(raceLoop);
  raceLoop = null;

  if (runner) Runner.stop(runner);

  if (engine) {
    World.clear(engine.world);
    Engine.clear(engine);
  }

  engine = null;
  runner = null;
});
