(() => {
  const socket = io();
  let me = null;
  let state = { players: {}, tokens: {}, cards: {}, handCounts: {}, deckCount: 0, discardCount: 0, boardImage: null };
  let selectedTokenColor = '#3498db';

  const $ = (sel) => document.querySelector(sel);
  const lobby = $('#lobby');
  const game = $('#game');
  const boardViewport = $('#boardViewport');
  const boardInner = $('#boardInner');
  const hand = $('#hand');
  const sidePanel = $('#sidePanel');
  const diceLog = $('#diceLog');

  const STACK_THRESHOLD = 5; // 보드 % 기준 이 거리 안에 놓으면 더미로 합쳐짐

  // ---------- 화면 줌/팬 상태 (클라이언트별로 독립적) ----------
  const view = { scale: 1, tx: 0, ty: 0 };
  function applyView() {
    boardInner.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  }
  function resetView() {
    view.scale = 1; view.tx = 0; view.ty = 0;
    applyView();
  }
  $('#resetViewBtn').addEventListener('click', resetView);

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angleBetween(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }

  // 화면 좌표(clientX/Y) -> boardInner 내부 기준 퍼센트 좌표로 변환 (줌/팬 반영)
  function screenToPercent(clientX, clientY) {
    const rect = boardViewport.getBoundingClientRect();
    const innerX = (clientX - rect.left - view.tx) / view.scale;
    const innerY = (clientY - rect.top - view.ty) / view.scale;
    return {
      x: Math.min(100, Math.max(0, (innerX / rect.width) * 100)),
      y: Math.min(100, Math.max(0, (innerY / rect.height) * 100))
    };
  }

  // 보드 배경 자체를 한 손가락(팬) / 두 손가락(핀치줌)으로 조작
  (() => {
    const pts = new Map();
    let panStart = null;
    let pinchStart = null;

    boardViewport.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      boardViewport.setPointerCapture(e.pointerId);
      sidePanel.classList.add('hidden');
      if (pts.size === 1) {
        panStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        pinchStart = null;
      } else if (pts.size === 2) {
        const [p1, p2] = [...pts.values()];
        pinchStart = { dist: dist(p1, p2), scale: view.scale };
        panStart = null;
      }
    });
    boardViewport.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1 && panStart) {
        view.tx = panStart.tx + (e.clientX - panStart.x);
        view.ty = panStart.ty + (e.clientY - panStart.y);
        applyView();
      } else if (pts.size === 2 && pinchStart) {
        const [p1, p2] = [...pts.values()];
        const ratio = dist(p1, p2) / (pinchStart.dist || 1);
        view.scale = Math.min(3, Math.max(0.4, pinchStart.scale * ratio));
        applyView();
      }
    });
    function end(e) {
      pts.delete(e.pointerId);
      if (pts.size === 0) { panStart = null; pinchStart = null; }
      else if (pts.size === 1) {
        const [[, p]] = pts;
        panStart = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
        pinchStart = null;
      }
    }
    boardViewport.addEventListener('pointerup', end);
    boardViewport.addEventListener('pointercancel', end);
    boardViewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.scale = Math.min(3, Math.max(0.4, view.scale - e.deltaY * 0.001));
      applyView();
    }, { passive: false });
  })();

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

  socket.on('token:moved', ({ id, x, y }) => {
    if (state.tokens[id]) { state.tokens[id].x = x; state.tokens[id].y = y; }
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) placeEl(el, x, y, state.tokens[id]?.rot || 0);
  });
  socket.on('token:rotated', ({ id, rot }) => {
    if (state.tokens[id]) state.tokens[id].rot = rot;
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) placeEl(el, state.tokens[id].x, state.tokens[id].y, rot);
  });
  socket.on('card:moved', ({ id, x, y }) => {
    if (state.cards[id]) { state.cards[id].x = x; state.cards[id].y = y; }
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) placeEl(el, x, y, state.cards[id]?.rot || 0);
  });
  socket.on('card:rotated', ({ id, rot }) => {
    if (state.cards[id]) state.cards[id].rot = rot;
    const el = document.getElementById(id);
    if (el && !el.dataset.dragging) placeEl(el, state.cards[id].x, state.cards[id].y, rot);
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
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const cards = [];
    suits.forEach((suit) => ranks.forEach((r) => cards.push({ label: r + suit, color: '#f5f6fa' })));
    socket.emit('deck:init', { cards });
  });
  $('#numberDeckBtn').addEventListener('click', () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({ label: String(i + 1), color: '#f5f6fa' }));
    socket.emit('deck:init', { cards });
  });
  $('#shuffleBtn').addEventListener('click', () => socket.emit('deck:shuffle'));
  $('#drawBtn').addEventListener('click', () => socket.emit('deck:draw'));

  // ---------- 보드 배경 이미지 ----------
  $('#boardImageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        socket.emit('board:setImage', { dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });
  $('#clearBoardImageBtn').addEventListener('click', () => socket.emit('board:setImage', { dataUrl: null }));

  // ---------- 렌더링 ----------
  function placeEl(el, x, y, rot) {
    el.style.left = x + '%';
    el.style.top = y + '%';
    el.style.transform = `translate(-50%, -50%) rotate(${rot || 0}deg)`;
  }

  function setBadge(el, count) {
    let badge = el.querySelector('.stack-badge');
    if (count > 1) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'stack-badge';
        el.appendChild(badge);
      }
      badge.textContent = count;
      el.classList.add('stacked');
    } else {
      if (badge) badge.remove();
      el.classList.remove('stacked');
    }
  }

  function render() {
    boardInner.style.backgroundImage = state.boardImage ? `url(${state.boardImage})` : '';
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
        boardInner.appendChild(el);
      }
      const top = t.stack && t.stack.length ? t.stack[t.stack.length - 1] : t;
      el.style.background = top.color;
      el.textContent = top.label || '';
      setBadge(el, 1 + (t.stack ? t.stack.length : 0));
      if (!el.dataset.dragging) placeEl(el, t.x, t.y, t.rot || 0);
    });
    [...boardInner.querySelectorAll('.token')].forEach((el) => {
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
        boardInner.appendChild(el);
      }
      const top = c.stack && c.stack.length ? state.cards[c.stack[c.stack.length - 1]] : c;
      if (top) {
        el.classList.toggle('facedown', !top.faceUp);
        el.style.background = top.faceUp ? top.color : '';
        el.textContent = top.faceUp ? top.label : '';
      }
      setBadge(el, 1 + (c.stack ? c.stack.length : 0));
      if (!el.dataset.dragging) placeEl(el, c.x, c.y, c.rot || 0);
    });
    [...boardInner.querySelectorAll('.board-card')].forEach((el) => {
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

  // ---------- 가까운 같은 종류 요소 찾기 (쌓기용) ----------
  function findMergeTarget(kind, id, x, y) {
    const dict = kind === 'token' ? state.tokens : state.cards;
    let best = null, bestDist = STACK_THRESHOLD;
    Object.values(dict).forEach((o) => {
      if (o.id === id) return;
      if (kind === 'card' && o.location !== 'board') return;
      const d = Math.hypot((o.x ?? 0) - x, (o.y ?? 0) - y);
      if (d < bestDist) { bestDist = d; best = o; }
    });
    return best;
  }

  // ---------- 드래그 + 두 손가락 회전 (보드 위 토큰/카드) ----------
  function makeDraggable(el, kind) {
    const pts = new Map();
    let mode = null;
    let moved = false;
    let rotateStart = null;

    function currentRot() {
      const o = kind === 'token' ? state.tokens[el.id] : state.cards[el.id];
      return o ? (o.rot || 0) : 0;
    }

    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.dataset.dragging = '1';
      if (pts.size === 1) {
        mode = 'drag';
        moved = false;
      } else if (pts.size === 2) {
        const [p1, p2] = [...pts.values()];
        rotateStart = { angle: angleBetween(p1, p2), rot: currentRot() };
        mode = 'rotate';
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'drag' && pts.size === 1) {
        moved = true;
        const { x, y } = screenToPercent(e.clientX, e.clientY);
        placeEl(el, x, y, currentRot());
        if (kind === 'token') socket.emit('token:move', { id: el.id, x, y });
        else socket.emit('card:move', { id: el.id, x, y });
      } else if (mode === 'rotate' && pts.size === 2) {
        const [p1, p2] = [...pts.values()];
        const delta = (angleBetween(p1, p2) - rotateStart.angle) * (180 / Math.PI);
        const rot = ((rotateStart.rot + delta) % 360 + 360) % 360;
        const cur = kind === 'token' ? state.tokens[el.id] : state.cards[el.id];
        placeEl(el, cur.x, cur.y, rot);
        if (kind === 'token') socket.emit('token:rotate', { id: el.id, rot });
        else socket.emit('card:rotate', { id: el.id, rot });
      }
    });

    function end(e) {
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        delete el.dataset.dragging;
        const { x, y } = screenToPercent(e.clientX, e.clientY);
        if (kind === 'token') {
          if (!moved) {
            const t = state.tokens[el.id];
            if (t && t.stack && t.stack.length) socket.emit('token:pop', { id: el.id });
          } else {
            socket.emit('token:move', { id: el.id, x, y });
            const target = findMergeTarget('token', el.id, x, y);
            if (target) socket.emit('token:merge', { sourceId: el.id, targetId: target.id });
          }
        } else {
          const handRect = hand.getBoundingClientRect();
          if (moved && e.clientY > handRect.top) {
            socket.emit('card:toDiscard', { id: el.id });
          } else if (!moved) {
            const c = state.cards[el.id];
            if (c && c.stack && c.stack.length) socket.emit('card:pop', { id: el.id });
            else socket.emit('card:flip', { id: el.id });
          } else {
            socket.emit('card:move', { id: el.id, x, y });
            const target = findMergeTarget('card', el.id, x, y);
            if (target) socket.emit('card:merge', { sourceId: el.id, targetId: target.id });
          }
        }
        mode = null;
      } else if (pts.size === 1) {
        mode = 'drag';
        moved = true;
      }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---------- 손패 카드를 보드로 내보내기 ----------
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
      const boardRect = boardViewport.getBoundingClientRect();
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
      const boardRect = boardViewport.getBoundingClientRect();
      if (moved && e.clientY < boardRect.bottom) {
        const { x, y } = screenToPercent(e.clientX, e.clientY);
        socket.emit('hand:play', { cardId, x, y, faceUp: true });
      } else if (!moved) {
        socket.emit('hand:play', { cardId, x: 50, y: 50, faceUp: true });
      }
    });
  }
})();
