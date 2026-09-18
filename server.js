const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> room state
const rooms = new Map();

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393'];

function makeId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: {},      // socketId -> { name, color }
      tokens: {},        // tokenId -> { id, x, y, color, label }
      cards: {},          // cardId -> { id, label, color, faceUp, location, x, y }
      deckOrder: [],      // array of cardId, top of deck = index 0
      discardOrder: []    // array of cardId
    });
  }
  return rooms.get(roomId);
}

// 덱 안 카드나 타인의 손패는 숨기고, 보드/버림더미 카드 전체 + 내 손패만 내려준다
function viewStateFor(room, viewerId) {
  const visibleCards = {};
  const handCounts = {};
  Object.values(room.cards).forEach((c) => {
    if (c.location === 'board' || c.location === 'discard') {
      visibleCards[c.id] = c;
    } else if (c.location.startsWith('hand:')) {
      const owner = c.location.slice(5);
      handCounts[owner] = (handCounts[owner] || 0) + 1;
      if (owner === viewerId) visibleCards[c.id] = c;
    }
  });
  return {
    id: room.id,
    players: room.players,
    tokens: room.tokens,
    cards: visibleCards,
    handCounts,
    deckCount: room.deckOrder.length,
    discardTop: room.discardOrder.length ? room.cards[room.discardOrder[0]] : null,
    discardCount: room.discardOrder.length
  };
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  Object.keys(room.players).forEach((sid) => {
    io.to(sid).emit('state', viewStateFor(room, sid));
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join', ({ roomId, name }) => {
    if (!roomId) return;
    currentRoomId = roomId;
    socket.join(roomId);
    const room = getOrCreateRoom(roomId);
    const colorIdx = Object.keys(room.players).length % PLAYER_COLORS.length;
    room.players[socket.id] = { name: (name || '플레이어').slice(0, 20), color: PLAYER_COLORS[colorIdx] };
    socket.emit('joined', { you: socket.id, room: viewStateFor(room, socket.id) });
    broadcastState(roomId);
  });

  socket.on('dice:roll', ({ sides = 6, count = 1 } = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    count = Math.max(1, Math.min(10, count | 0));
    sides = Math.max(2, Math.min(100, sides | 0));
    const results = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const by = room.players[socket.id]?.name || '누군가';
    io.to(currentRoomId).emit('dice:result', { results, sides, by, ts: Date.now() });
  });

  socket.on('token:add', ({ color, label, x, y }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const id = makeId('tok');
    room.tokens[id] = { id, x: x ?? 50, y: y ?? 50, color: color || '#3498db', label: (label || '').slice(0, 6) };
    broadcastState(currentRoomId);
  });

  socket.on('token:move', ({ id, x, y }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.tokens[id]) return;
    room.tokens[id].x = x;
    room.tokens[id].y = y;
    // 위치 갱신은 자주 발생하므로 브로드캐스트만, 상태 전체 재전송 대신 경량 이벤트
    socket.to(currentRoomId).emit('token:moved', { id, x, y });
  });

  socket.on('token:remove', ({ id }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    delete room.tokens[id];
    broadcastState(currentRoomId);
  });

  // 덱 생성: [{label, color}] 형태의 카드 정의 배열을 받아 새 덱을 만든다
  socket.on('deck:init', ({ cards } = {}) => {
    if (!currentRoomId || !Array.isArray(cards)) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.cards = {};
    room.deckOrder = [];
    room.discardOrder = [];
    cards.forEach((c) => {
      const id = makeId('card');
      room.cards[id] = { id, label: (c.label || '?').slice(0, 12), color: c.color || '#ecf0f1', faceUp: false, location: 'deck', x: 0, y: 0 };
      room.deckOrder.push(id);
    });
    shuffle(room.deckOrder);
    broadcastState(currentRoomId);
  });

  socket.on('deck:shuffle', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    shuffle(room.deckOrder);
    broadcastState(currentRoomId);
  });

  socket.on('deck:draw', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.deckOrder.length === 0) return;
    const id = room.deckOrder.shift();
    room.cards[id].location = 'hand:' + socket.id;
    room.cards[id].faceUp = false;
    broadcastState(currentRoomId);
  });

  socket.on('hand:play', ({ cardId, x, y, faceUp }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.cards[cardId]) return;
    room.cards[cardId].location = 'board';
    room.cards[cardId].x = x ?? 50;
    room.cards[cardId].y = y ?? 50;
    room.cards[cardId].faceUp = !!faceUp;
    broadcastState(currentRoomId);
  });

  socket.on('card:move', ({ id, x, y }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.cards[id] || room.cards[id].location !== 'board') return;
    room.cards[id].x = x;
    room.cards[id].y = y;
    socket.to(currentRoomId).emit('card:moved', { id, x, y });
  });

  socket.on('card:flip', ({ id }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.cards[id]) return;
    room.cards[id].faceUp = !room.cards[id].faceUp;
    broadcastState(currentRoomId);
  });

  socket.on('card:toDiscard', ({ id }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.cards[id]) return;
    room.cards[id].location = 'discard';
    room.cards[id].faceUp = true;
    room.discardOrder.unshift(id);
    broadcastState(currentRoomId);
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      rooms.delete(currentRoomId);
    } else {
      broadcastState(currentRoomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tabletop sim server listening on ${PORT}`));
