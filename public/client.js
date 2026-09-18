(() => {
  const socket = io();
  let me = null;
  let state = { players: {}, tokens: {}, cards: {}, handCounts: {}, deckCount: 0, discardCount: 0 };
  let selectedTokenColor = '#3498db';

  const $ = (sel) => document.querySelector(sel);
  const lobby = $('#lobby');
  const game = $('#game');
  const board = $('#board');
  const hand = $('#hand');
  const sidePanel = $('#sidePanel');
  const diceLog = $('#diceLog');

  // ---------- 로비 ----------
  $('#joinBtn').addEventListener('click', () => {
    const name = $('#nameInput').value.trim() || '플레이어';
    let roomId = $('#roomInput').value.trim();
    if (!roomId) roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    socket.emit('join', { roomId, name });
  });

  socket.on('joined', ({ you, room }) => {
    me = you;
    state = room;
    lobby.classList.add('hidden');
    game.classList.remove('hidden');
    $('#roomLabel').textContent = '방: ' + room.id;
    render();
  });

  socket.on('state', (room) => {
    state = room;
    render();
  });

  // 드래그 중 부드러운 이동을 위한 경량 이벤트 (전체 재렌더 없이 위치만 갱신)
  socket.on('token:moved', ({ id, x, y }) => {
    if (state.tokens[id]) { state.tokens[id].x = x; state.tokens[id].y = y; }
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) positionEl(el, x, y);
  });
  socket.on('card:moved', ({ id, x, y }) => {
    if (state.cards[id]) { state.cards[id].x = x; state.cards[id].y = y; }
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) positionEl(el, x, y);
  });

  socket.on('dice:result', ({ results, sides, by }) => {
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.textContent = `${by}: d${sides} → ${results.join(', ')}`;
    diceLog.appendChild(entry);
    setTimeout(() => entry.remove(), 4000);
  });

  // ---------- 메뉴 ----------
  $('#menuBtn').addEventListener('click', () => sidePanel.classList.toggle('hidden'));
  board.addEventListener('pointerdown', () => sidePanel.classList.add('hidden'));

  // ---------- 주사위 ----------
  const DICE_PRESETS = [4, 6, 8, 10, 12, 20];
  const diceButtonsEl = $('#diceButtons');
  DICE_PRESETS.forEach((sides) => {
    const b = document.createElement('button');
    b.textContent = 'd' + sides;
    b.addEventListener('click', () => socket.emit('dice:roll', { sides, count: Number($('#diceCount').value) || 1 }));
    diceButtonsEl.appendChild(b);
  });
  $('#rollCustom').addEventListener('click', () => {
    socket.emit('dice:roll', {
      sides: Number($('#diceSidesCustom').value) || 6,
      count: Number($('#diceCount').value) || 1
    });
  });

  // ---------- 토큰 ----------
  const TOKEN_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
  const tokenColorsEl = $('#tokenColors');
  TOKEN_COLORS.forEach((c, i) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (i === 0 ? ' selected' : '');
    s.style.background = c;
    s.addEventListener('click', () => {
      selectedTokenColor = c;
      [...tokenColorsEl.children].forEach((el) => el.classList.remove('selected'));
      s.classList.add('selected');
    });
    tokenColorsEl.appendChild(s);
  });
  $('#addTokenBtn').addEventListener('click', () => {
    socket.emit('token:add', { color: selectedTokenColor, x: 40 + Math.random() * 20, y: 40 + Math.random() * 20, label: '' });
    sidePanel.classList.add('hidden');
  });

  // ---------- 덱 ----------
  $('#defaultDeckBtn').addEventListener('click', () => {
    const suits = [['♠', '#111'], ['♥', '#c0392b'], ['♦', '#c0392b'], ['♣', '#111']];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const cards = [];
    suits.forEach(([suit]) => ranks.forEach((r) => cards.push({ label: r + suit, color: '#f5f6fa' })));
    socket.emit('deck:init', { cards });
  });
  $('#numberDeckBtn').addEventListener('click', () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({ label: String(i + 1), color: '#f5f6fa' }));
    socket.emit('deck:init', { cards });
  });
  $('#shuffleBtn').addEventListener('click', () => socket.emit('deck:shuffle'));
  $('#drawBtn').addEventListener('click', () => socket.emit('deck:draw'));

  // ---------- 렌더링 ----------
  function positionEl(el, x, y) {
    el.style.left = x + '%';
    el.style.top = y + '%';
  }

  function render() {
    $('#playerList').textContent = Object.values(state.players).map((p) => p.name).join(', ');
    $('#deckCount').textContent = state.deckCount;
    $('#discardCount').textContent = state.discardCount;

    // 토큰
    const seenIds = new Set();
    Object.values(state.tokens).forEach((t) => {
      seenIds.add(t.id);
      let el = document.getElementById(t.id);
      if (!el) {
        el = document.createElement('div');
        el.id = t.id;
        el.className = 'token';
        makeDraggable(el, 'token');
        board.appendChild(el);
      }
      el.style.background = t.color;
      el.textContent = t.label || '';
      if (!el.dataset.dragging) positionEl(el, t.x, t.y);
    });
    [...board.querySelectorAll('.token')].forEach((el) => {
      if (!seenIds.has(el.id)) el.remove();
    });

    // 보드 위 카드
    const seenCardIds = new Set();
    Object.values(state.cards).forEach((c) => {
      if (c.location !== 'board') return;
      seenCardIds.add(c.id);
      let el = document.getElementById(c.id);
      if (!el) {
        el = document.createElement('div');
        el.id = c.id;
        el.className = 'board-card';
        makeDraggable(el, 'card');
        board.appendChild(el);
      }
      el.classList.toggle('facedown', !c.faceUp);
      el.style.background = c.faceUp ? c.color : '';
      el.textContent = c.faceUp ? c.label : '';
      if (!el.dataset.dragging) positionEl(el, c.x, c.y);
    });
    [...board.querySelectorAll('.board-card')].forEach((el) => {
      if (!seenCardIds.has(el.id)) el.remove();
    });

    // 내 손패
    hand.innerHTML = '';
    Object.values(state.cards)
      .filter((c) => c.location === 'hand:' + me)
      .forEach((c) => {
        const el = document.createElement('div');
        el.id = c.id;
        el.className = 'hand-card';
        el.style.background = c.color;
        el.textContent = c.label;
        makeHandCardDraggable(el, c.id);
        hand.appendChild(el);
      });
  }

  // ---------- 드래그: 보드 위 토큰/카드 이동 (Pointer Events로 마우스/터치 통합) ----------
  function makeDraggable(el, kind) {
    let startX, startY, moved;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.dataset.dragging = '1';
      startX = e.clientX; startY = e.clientY; moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.dataset.dragging) return;
      moved = true;
      const rect = board.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
      positionEl(el, x, y);
      if (kind === 'token') socket.emit('token:move', { id: el.id, x, y });
      else socket.emit('card:move', { id: el.id, x, y });
    });
    el.addEventListener('pointerup', (e) => {
      delete el.dataset.dragging;
      const rect = board.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
      if (kind === 'token') {
        socket.emit('token:move', { id: el.id, x, y });
      } else {
        // 손패 영역까지 끌고 내려오면 버림더미로 보낸다
        const handRect = hand.getBoundingClientRect();
        if (e.clientY > handRect.top) {
          socket.emit('card:toDiscard', { id: el.id });
        } else {
          socket.emit('card:move', { id: el.id, x, y });
          if (!moved) socket.emit('card:flip', { id: el.id }); // 탭이면 뒤집기
        }
      }
    });
  }

  // ---------- 드래그: 손패 카드를 보드로 내보내기 ----------
  function makeHandCardDraggable(el, cardId) {
    let ghost = null;
    let moved = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.dataset.dragging = '1';
      moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.dataset.dragging) return;
      moved = true;
      const boardRect = board.getBoundingClientRect();
      if (e.clientY < boardRect.bottom) {
        if (!ghost) {
          ghost = el.cloneNode(true);
          ghost.style.position = 'fixed';
          ghost.style.pointerEvents = 'none';
          ghost.style.zIndex = 50;
          ghost.style.width = '52px';
          ghost.style.height = '72px';
          document.body.appendChild(ghost);
        }
        ghost.style.left = (e.clientX - 26) + 'px';
        ghost.style.top = (e.clientY - 36) + 'px';
      } else if (ghost) {
        ghost.remove(); ghost = null;
      }
    });
    el.addEventListener('pointerup', (e) => {
      delete el.dataset.dragging;
      if (ghost) { ghost.remove(); ghost = null; }
      const boardRect = board.getBoundingClientRect();
      if (moved && e.clientY < boardRect.bottom) {
        const x = Math.min(100, Math.max(0, ((e.clientX - boardRect.left) / boardRect.width) * 100));
        const y = Math.min(100, Math.max(0, ((e.clientY - boardRect.top) / boardRect.height) * 100));
        socket.emit('hand:play', { cardId, x, y, faceUp: true });
      } else if (!moved) {
        // 탭하면 보드 중앙에 앞면으로 낸다
        socket.emit('hand:play', { cardId, x: 50, y: 50, faceUp: true });
      }
    });
  }
})();
