/**
 * MindMap & Notes Sync - Web Edition
 * Converted from BnjrApp (Android/Kotlin)
 */

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  positions: [],
  notes: {},          // word -> note content (synced by name)
  history: [],
  clipboard: [],
  selected: new Set(),
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  isDark: true,
  isSelectionMode: false,
  lassoRect: null,
  editingIndex: -1,
  isReadingMode: true,
  isAiGenerating: false,
  showHistory: false,
  showAllNotes: false,
  showDiaporama: false,
  showSettings: false,
  diaporamaList: [],
  isDiaporamaRunning: false,
  isDiaporamaPaused: false,
  currentDiaporamaIndex: 0,
  autoPlayEnabled: false,
  autoReadEnabled: false,
  searchQuery: '',
  apiKeys: { deepseek: '', openai: '' },
};

// ─── DOM ─────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('mindmap-canvas');
const ctx = canvas.getContext('2d');
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mindmap_data';

function getSyncPayload() {
  return {
    positions: state.positions,
    notes: state.notes,
    history: state.history,
    settings: {
      zoom: state.zoom,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
      isDark: state.isDark,
      diaporamaList: state.diaporamaList,
    },
  };
}

function applyData(data) {
  state.positions = (data.positions || []).map(p => ({
    word: p.word,
    x: p.x,
    y: p.y,
    level: p.level || 0,
  }));
  state.notes = data.notes || {};
  (data.positions || []).forEach(p => {
    if (p.note && !state.notes[p.word?.toLowerCase()]) {
      state.notes[p.word.toLowerCase()] = p.note;
    }
  });
  state.history = data.history || [];
  const s = data.settings || data;
  state.zoom = s.zoom ?? state.zoom ?? 1;
  state.offsetX = s.offsetX ?? state.offsetX ?? 0;
  state.offsetY = s.offsetY ?? state.offsetY ?? 0;
  state.isDark = s.isDark ?? state.isDark ?? true;
  state.diaporamaList = s.diaporamaList || state.diaporamaList || [];
  state.apiKeys = { deepseek: '', openai: '' };
  preserveLocalApiKeys();
}

function buildLocalData(updatedAt) {
  return {
    positions: state.positions,
    notes: state.notes,
    history: state.history,
    zoom: state.zoom,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    isDark: state.isDark,
    diaporamaList: state.diaporamaList,
    apiKeys: state.apiKeys,
    _updatedAt: updatedAt || new Date().toISOString(),
  };
}

function persistLocal(updatedAt) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalData(updatedAt)));
}

function preserveLocalApiKeys() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const local = JSON.parse(raw);
      if (local.apiKeys) state.apiKeys = local.apiKeys;
    }
  } catch { /* ignore */ }
}

function save(options = {}) {
  pruneOrphanNotes();
  const updatedAt = new Date().toISOString();
  persistLocal(updatedAt);
  Sync.scheduleSync(getSyncPayload, options.immediate);
}

function pruneOrphanNotes() {
  const words = new Set(state.positions.map((p) => p.word.toLowerCase()));
  Object.keys(state.notes).forEach((key) => {
    if (!words.has(key)) delete state.notes[key];
  });
}

function removeNotesForWords(words) {
  words.forEach((word) => {
    delete state.notes[word.toLowerCase()];
  });
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      applyData(JSON.parse(raw));
      return;
    } catch (e) { /* fall through */ }
  }
  initDefaultData();
}

function getNote(word) {
  return state.notes[word.toLowerCase()] || '';
}

function setNote(word, content) {
  state.notes[word.toLowerCase()] = content;
  save();
}

function initDefaultData() {
  const words = [
    "Morning Routine", "Alarm clock", "Wake up", "Drink water",
    "Stretch", "Get out of bed", "Make the bed", "Bathroom",
    "Shower", "Brush teeth", "Shave", "Get dressed",
    "Breakfast", "Coffee", "Tea", "Plan the day",
    "Evening Routine", "Unwind", "Dinner", "Wash dishes",
    "Read a book", "Journaling", "Skin care", "Pyjamas",
    "Set alarm", "Turn off lights", "Sleep", "Dream",
    "Motivation", "Focus", "Discipline", "Consistency",
    "Hard work", "Success", "Growth", "Persistence",
    "Energy", "Positive vibes", "Goal setting", "Action"
  ];

  const clusters = [
    { hx: -600, hy: -400, words: words.slice(0, 16) },
    { hx: 600, hy: 500, words: words.slice(16, 28) },
    { hx: 700, hy: -300, words: words.slice(28) },
  ];

  state.positions = [];
  clusters.forEach(({ hx, hy, words: clusterWords }) => {
    clusterWords.forEach((word, i) => {
      if (i === 0) {
        state.positions.push({ word, x: hx, y: hy, level: 0 });
      } else {
        const angle = i * 0.7;
        const distance = 180 + (i % 3) * 40;
        state.positions.push({
          word,
          x: hx + distance * Math.cos(angle),
          y: hy + distance * Math.sin(angle),
          level: 0,
        });
      }
    });
  });
  save();
}

// ─── Canvas Rendering ────────────────────────────────────────────────────────

function resizeCanvas() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  render();
}

function getColors() {
  return state.isDark
    ? { bg: '#0f0f1a', text: '#e0e0e0', accent: '#bb86fc', cyan: '#00e5ff', yellow: '#ffeb3b' }
    : { bg: '#f5f5fa', text: '#1a1a1a', accent: '#6200ee', cyan: '#00bcd4', yellow: '#f9a825' };
}

function render() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const colors = getColors();
  const cx = w / 2;
  const cy = h / 2;

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  // Grid
  const gridSpacing = 100 * state.zoom;
  const startX = (cx + state.offsetX * state.zoom) % gridSpacing;
  const startY = (cy + state.offsetY * state.zoom) % gridSpacing;

  ctx.strokeStyle = 'rgba(128,128,128,0.2)';
  ctx.lineWidth = 1;
  for (let x = startX; x <= w; x += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = startY; y <= h; y += gridSpacing) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Words
  state.positions.forEach((pos, index) => {
    const sx = cx + (pos.x + state.offsetX) * state.zoom;
    const sy = cy + (pos.y + state.offsetY) * state.zoom;

    if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100) return;

    const isSelected = state.selected.has(index);
    const isSearchMatch = state.searchQuery && pos.word.toLowerCase().includes(state.searchQuery.toLowerCase());

    const baseSize = { 1: 32, 2: 24, 3: 20 }[pos.level] || 16;
    const fontSize = baseSize * state.zoom;

    ctx.font = `${(isSelected || isSearchMatch || pos.level) ? 'bold' : '500'} ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const metrics = ctx.measureText(pos.word);
    const textW = metrics.width;

    if (isSelected) {
      ctx.fillStyle = 'rgba(0,229,255,0.2)';
      ctx.beginPath();
      ctx.arc(sx, sy, textW * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    if (isSelected) ctx.fillStyle = colors.cyan;
    else if (isSearchMatch) ctx.fillStyle = colors.yellow;
    else if (pos.level) ctx.fillStyle = colors.accent;
    else ctx.fillStyle = colors.text + 'cc';

    ctx.fillText(pos.word, sx, sy);
  });

  // Lasso rectangle
  if (state.lassoRect) {
    const r = state.lassoRect;
    ctx.fillStyle = colors.accent + '4d';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  $('#zoom-indicator').textContent = `Zoom: ${state.zoom.toFixed(1)}x`;
}

// ─── Hit Testing ─────────────────────────────────────────────────────────────

function findWordAt(screenX, screenY, threshold = 60) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cx = w / 2;
  const cy = h / 2;
  let best = -1;
  let minDist = threshold;

  state.positions.forEach((pos, index) => {
    const sx = cx + (pos.x + state.offsetX) * state.zoom;
    const sy = cy + (pos.y + state.offsetY) * state.zoom;
    const dist = Math.hypot(screenX - sx, screenY - sy);
    if (dist < minDist) {
      minDist = dist;
      best = index;
    }
  });
  return best;
}

function screenToWorld(screenX, screenY) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  return {
    x: (screenX - cx) / state.zoom - state.offsetX,
    y: (screenY - cy) / state.zoom - state.offsetY,
  };
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

function speak(text, interrupt = true) {
  if (!text || !window.speechSynthesis) return;
  if (interrupt) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  speechSynthesis.speak(utterance);
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function showModal(title, bodyHtml, buttons) {
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  content.innerHTML = `<h2>${title}</h2>${bodyHtml}<div class="modal-footer">${buttons.map(b =>
    `<button class="btn ${b.class || 'btn-secondary'}" data-action="${b.action}">${b.label}</button>`
  ).join('')}</div>`;
  overlay.classList.remove('hidden');

  content.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'close') hideModal();
      else if (buttons.find(b => b.action === action)?.onClick) {
        buttons.find(b => b.action === action).onClick();
      }
    });
  });
}

function hideModal() {
  $('#modal-overlay').classList.add('hidden');
}

$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideModal();
});

// ─── Interactions ────────────────────────────────────────────────────────────

let isDragging = false;
let dragStart = null;
let longPressTimer = null;
let longPressTriggered = false;
let lastEmptyTap = { x: 0, y: 0, time: 0 };
let movedDuringPress = false;

function handleTap(screenX, screenY) {
  const index = findWordAt(screenX, screenY);
  if (index !== -1) {
    if (state.selected.has(index)) {
      openNote(index);
    } else {
      speak(state.positions[index].word);
      state.selected = new Set([index]);
    }
    lastEmptyTap.time = 0;
  } else {
    const now = Date.now();
    const isDoubleOnEmpty = lastEmptyTap.time > 0
      && now - lastEmptyTap.time < 500
      && Math.hypot(screenX - lastEmptyTap.x, screenY - lastEmptyTap.y) < 40;

    if (isDoubleOnEmpty) {
      const world = screenToWorld(screenX, screenY);
      showAddWordDialog(world.x, world.y);
      lastEmptyTap.time = 0;
    } else {
      state.selected = new Set();
      lastEmptyTap = { x: screenX, y: screenY, time: now };
    }
  }
  render();
}

function handleLongPress(screenX, screenY) {
  const index = findWordAt(screenX, screenY);
  if (index !== -1) {
    if (state.selected.has(index)) {
      showWordActionsMenu(index);
    } else {
      state.selected = new Set([index]);
      render();
    }
  } else {
    const world = screenToWorld(screenX, screenY);
    if (state.clipboard.length > 0) {
      showEmptySpaceMenu(screenX, screenY, world);
    }
  }
}

function showAddWordDialog(worldX, worldY) {
  if (!$('#modal-overlay').classList.contains('hidden')) return;

  const submitAdd = () => {
    const input = $('#modal-word-input');
    if (!input) return;
    const val = input.value.trim();
    if (val) addWord(val, worldX, worldY);
    hideModal();
  };

  showModal('Add a word', `
    <input type="text" id="modal-word-input" placeholder="Create..." autofocus>
    <div id="modal-suggestions"></div>
  `, [
    { label: 'Cancel', action: 'close' },
    { label: 'Add', action: 'add', class: 'btn-primary', onClick: submitAdd },
  ]);

  const input = $('#modal-word-input');
  input.addEventListener('input', () => updateSuggestions(input.value, worldX, worldY));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAdd();
    }
  });
  input.focus();
}

function updateSuggestions(query, worldX, worldY) {
  const el = $('#modal-suggestions');
  if (!el) return;
  if (!query.trim()) { el.innerHTML = ''; return; }

  const matches = state.positions
    .filter(p => p.word.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5);

  if (matches.length) {
    el.innerHTML = matches.map(p => `
      <div class="search-result-item" data-word="${escapeHtml(p.word)}">📄 ${escapeHtml(p.word)}</div>
    `).join('');
    el.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        addWord(item.dataset.word, worldX, worldY);
        hideModal();
      });
    });
  } else {
    el.innerHTML = `<div class="search-result-item create">✨ Create new: "${escapeHtml(query)}"</div>`;
  }
}

function addWord(word, x, y) {
  const existing = state.positions.find(p => p.word.toLowerCase() === word.toLowerCase());
  state.positions.push({ word, x, y, level: 0 });
  if (existing && getNote(existing.word)) {
    setNote(word, getNote(existing.word));
  }
  state.selected = new Set([state.positions.length - 1]);
  save();
  render();
}

function showEmptySpaceMenu(screenX, screenY, world) {
  showModal('Actions', `
    <p>What do you want to do here?</p>
    <div class="modal-actions">
      <button class="btn btn-block btn-primary" id="modal-select-multi">Select Multiple Words 🟦</button>
      <button class="btn btn-block btn-primary" id="modal-add-word">Quick Switcher / Add Word 🔍</button>
      ${state.clipboard.length ? `
        <button class="btn btn-block btn-primary" id="modal-paste">📋 Coller ici (${state.clipboard.length} éléments)</button>
        <button class="btn btn-block btn-danger" id="modal-clear-clip">🗑️ Vider le presse-papier</button>
      ` : ''}
    </div>
  `, [{ label: 'Cancel', action: 'close' }]);

  $('#modal-select-multi')?.addEventListener('click', () => {
    state.isSelectionMode = true;
    canvas.classList.add('lasso');
    $('#btn-lasso').classList.add('active');
    hideModal();
  });
  $('#modal-add-word')?.addEventListener('click', () => {
    hideModal();
    showAddWordDialog(world.x, world.y);
  });
  $('#modal-paste')?.addEventListener('click', () => {
    state.clipboard.forEach(p => {
      state.positions.push({ word: p.word, x: world.x + p.x, y: world.y + p.y, level: p.level });
    });
    save();
    showToast(`${state.clipboard.length} elements pasted`);
    hideModal();
    render();
  });
  $('#modal-clear-clip')?.addEventListener('click', () => {
    state.clipboard = [];
    hideModal();
  });
}

function showWordActionsMenu(index) {
  const pos = state.positions[index];
  const isMulti = state.selected.size > 1;

  showModal('Actions', `
    <p>${isMulti ? `Voulez-vous supprimer les ${state.selected.size} mots sélectionnés ?` : `Actions pour "${escapeHtml(pos.word)}" :`}</p>
    ${!isMulti ? `
      <p style="margin-top:12px;font-size:13px;opacity:0.7">Changer la hiérarchie :</p>
      <div class="chip-group" id="level-chips">
        ${[['H1',1],['H2',2],['H3',3],['Normal',0]].map(([l,v]) =>
          `<button class="chip ${pos.level===v?'selected':''}" data-level="${v}">${l}</button>`
        ).join('')}
      </div>
    ` : ''}
    <div class="modal-actions">
      <button class="btn btn-block btn-primary" id="modal-copy">📋 Copier la sélection</button>
      ${!isMulti ? `<button class="btn btn-block btn-primary" id="modal-diapo-sel">📽️ Diaporama de sélection</button>` : ''}
    </div>
  `, [
    { label: 'Annuler', action: 'close' },
    { label: 'Supprimer', action: 'delete', class: 'btn-danger', onClick: () => {
      const toRemove = [...state.selected].sort((a, b) => b - a);
      const removedWords = toRemove.map((i) => state.positions[i]?.word).filter(Boolean);
      toRemove.forEach(i => state.positions.splice(i, 1));
      removeNotesForWords(removedWords);
      state.selected = new Set();
      save({ immediate: true });
      hideModal();
      render();
    }},
  ]);

  $('#level-chips')?.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.positions[index].level = +chip.dataset.level;
      save();
      render();
      chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
  });

  $('#modal-copy')?.addEventListener('click', () => {
    state.clipboard = [];
    const indices = [...state.selected];
    if (indices.length) {
      const ref = state.positions[indices[0]];
      indices.forEach(i => {
        const p = state.positions[i];
        state.clipboard.push({ word: p.word, x: p.x - ref.x, y: p.y - ref.y, level: p.level });
      });
      showToast(`${state.clipboard.length} elements copied`);
    }
    hideModal();
  });

  $('#modal-diapo-sel')?.addEventListener('click', () => {
    const selected = [...state.selected].map(i => state.positions[i]);
    selected.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 20) return a.x - b.x;
      return a.y - b.y;
    });
    state.diaporamaList = [...new Set(selected.map(p => p.word))];
    save();
    hideModal();
    showToast(`Diaporama: ${state.diaporamaList.length} notes`);
    openDiaporamaPage();
  });
}

// ─── Pointer Events ──────────────────────────────────────────────────────────

function onPointerDown(e) {
  if (state.editingIndex !== -1) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  isDragging = true;
  movedDuringPress = false;
  longPressTriggered = false;
  dragStart = { x, y, time: Date.now() };

  if (state.isSelectionMode) {
    state.lassoRect = { x, y, w: 0, h: 0 };
    return;
  }

  longPressTimer = setTimeout(() => {
    if (!movedDuringPress) {
      longPressTriggered = true;
      handleLongPress(x, y);
    }
  }, 500);
}

function onPointerMove(e) {
  if (!isDragging || !dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dx = x - dragStart.x;
  const dy = y - dragStart.y;

  if (Math.hypot(dx, dy) > 8) {
    movedDuringPress = true;
    clearTimeout(longPressTimer);
  }

  if (state.isSelectionMode && state.lassoRect) {
    state.lassoRect.w = dx;
    state.lassoRect.h = dy;
    render();
    return;
  }

  if (state.selected.size > 0 && !state.isSelectionMode) {
    state.selected.forEach(i => {
      state.positions[i].x += dx / state.zoom;
      state.positions[i].y += dy / state.zoom;
    });
    dragStart.x = x;
    dragStart.y = y;
    save();
    render();
  } else if (!state.isSelectionMode) {
    state.offsetX += dx / state.zoom;
    state.offsetY += dy / state.zoom;
    dragStart.x = x;
    dragStart.y = y;
    render();
  }
}

function onPointerUp(e) {
  clearTimeout(longPressTimer);
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (state.isSelectionMode && state.lassoRect) {
    const r = state.lassoRect;
    const rx = Math.min(r.x, r.x + r.w);
    const ry = Math.min(r.y, r.y + r.h);
    const rw = Math.abs(r.w);
    const rh = Math.abs(r.h);
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    const newSelected = new Set();
    state.positions.forEach((pos, index) => {
      const sx = cx + (pos.x + state.offsetX) * state.zoom;
      const sy = cy + (pos.y + state.offsetY) * state.zoom;
      if (sx >= rx && sx <= rx + rw && sy >= ry && sy <= ry + rh) {
        newSelected.add(index);
      }
    });
    state.selected = newSelected;
    state.lassoRect = null;
    state.isSelectionMode = false;
    canvas.classList.remove('lasso');
    $('#btn-lasso').classList.remove('active');
    render();
  } else if (!movedDuringPress && dragStart && !longPressTriggered) {
    handleTap(x, y);
  }

  isDragging = false;
  dragStart = null;
  canvas.classList.remove('grabbing');
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.classList.add('grabbing');
  canvas.setPointerCapture(e.pointerId);
  onPointerDown(e);
});
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0008);
  state.zoom = Math.max(0.1, Math.min(4, state.zoom * factor));
  render();
}, { passive: false });

// Pinch zoom for touch
let lastPinchDist = 0;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    lastPinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastPinchDist) {
      const rawFactor = dist / lastPinchDist;
      const factor = 1 + (rawFactor - 1) * 0.25;
      state.zoom = Math.max(0.1, Math.min(4, state.zoom * factor));
      render();
    }
    lastPinchDist = dist;
  }
}, { passive: true });

canvas.addEventListener('touchend', () => { lastPinchDist = 0; });

canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (findWordAt(x, y) === -1) {
    e.preventDefault();
    const world = screenToWorld(x, y);
    showAddWordDialog(world.x, world.y);
    lastEmptyTap.time = 0;
  }
});

// ─── Search ──────────────────────────────────────────────────────────────────

const searchInput = $('#search-input');
const searchResults = $('#search-results');

searchInput.addEventListener('input', () => {
  state.searchQuery = searchInput.value;
  $('#search-clear').classList.toggle('hidden', !searchInput.value);

  if (!searchInput.value.trim()) {
    searchResults.classList.add('hidden');
    render();
    return;
  }

  const q = searchInput.value.toLowerCase();
  const matches = state.positions
    .map((p, i) => ({ ...p, index: i }))
    .filter(p => p.word.toLowerCase().includes(q))
    .slice(0, 5);

  if (matches.length) {
    searchResults.innerHTML = matches.map(p => `
      <div class="search-result-item" data-index="${p.index}">📄 ${escapeHtml(p.word)}</div>
    `).join('');
  } else {
    searchResults.innerHTML = `
      <div class="search-result-item create" id="search-create">✨ Create "${escapeHtml(searchInput.value)}"</div>
    `;
  }

  searchResults.classList.remove('hidden');
  render();

  searchResults.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.id === 'search-create') {
        addWord(searchInput.value.trim(), -state.offsetX, -state.offsetY);
      } else {
        const idx = +item.dataset.index;
        const pos = state.positions[idx];
        state.offsetX = -pos.x;
        state.offsetY = -pos.y;
        state.zoom = 1.5;
        state.selected = new Set([idx]);
      }
      searchInput.value = '';
      state.searchQuery = '';
      searchResults.classList.add('hidden');
      $('#search-clear').classList.add('hidden');
      render();
    });
  });
});

$('#search-clear').addEventListener('click', () => {
  searchInput.value = '';
  state.searchQuery = '';
  searchResults.classList.add('hidden');
  $('#search-clear').classList.add('hidden');
  render();
});

// ─── Action Buttons ──────────────────────────────────────────────────────────

$('#btn-lasso').addEventListener('click', () => {
  state.isSelectionMode = !state.isSelectionMode;
  canvas.classList.toggle('lasso', state.isSelectionMode);
  $('#btn-lasso').classList.toggle('active', state.isSelectionMode);
  if (!state.isSelectionMode) state.selected = new Set();
  render();
});

$('#btn-theme').addEventListener('click', () => {
  state.isDark = !state.isDark;
  document.body.classList.toggle('light', !state.isDark);
  document.body.classList.toggle('dark', state.isDark);
  $('#btn-theme').textContent = state.isDark ? '☀️' : '🌙';
  save();
  render();
});

$('#btn-history').addEventListener('click', openHistoryPage);
$('#btn-diaporama').addEventListener('click', openDiaporamaPage);
$('#btn-all-notes').addEventListener('click', openAllNotesPage);
$('#btn-export').addEventListener('click', exportData);
$('#btn-settings').addEventListener('click', openSettingsPage);
$('#btn-backup').addEventListener('click', openBackupPage);

// ─── Note View ───────────────────────────────────────────────────────────────

function openNote(index) {
  state.editingIndex = index;
  state.isReadingMode = true;
  const word = state.positions[index].word;

  addHistory(word);
  speak(word);
  renderNoteView();
  $('#page-note').classList.remove('hidden');
}

function addHistory(word) {
  state.history.unshift({ word, timestamp: Date.now() });
  if (state.history.length > 100) state.history.length = 100;
  save();
}

function renderNoteView() {
  if (state.editingIndex === -1) return;
  const pos = state.positions[state.editingIndex];
  const note = getNote(pos.word);
  const page = $('#page-note');

  page.innerHTML = `
    <div class="note-view">
      ${state.isDiaporamaRunning ? '<div class="diaporama-progress" id="note-dia-progress" style="position:relative;height:3px;background:var(--accent);width:0%"></div>' : ''}
      <div class="page-header">
        <div style="flex:1">
          <div class="note-title">${escapeHtml(pos.word)}</div>
          <div class="note-toolbar">
            <button onclick="App.googleSearch()" title="Google">🔍</button>
            <button onclick="App.googleImages()" title="Images">🖼️</button>
            <button onclick="App.googleMaps()" title="Maps">📍</button>
            <button onclick="App.speakTitle()" title="TTS Title">📢</button>
            <button onclick="App.speakNote()" title="TTS Note">📝🔊</button>
            <button onclick="App.pickImage()" title="Photo">📷</button>
            <button onclick="App.insertWikilink()" title="Wikilink">[[]]</button>
            <button onclick="App.toggleMode()" title="Mode">${state.isReadingMode ? '✍️' : '📖'}</button>
            <button onclick="App.generateAI()" title="AI" id="btn-ai">${state.isAiGenerating ? '<span class="spinner"></span>' : '✨'}</button>
            <div class="timer" id="note-timer" onclick="App.toggleTimer()">⏱️ <span id="timer-text">00:00</span></div>
            <button onclick="App.resetTimer()" id="btn-reset-timer" style="display:none">🔄</button>
          </div>
        </div>
        <button class="btn-icon" onclick="App.closeNote()">❌</button>
      </div>
      <div class="note-mode-label">${state.isReadingMode ? 'Reading View' : 'Editing View'}</div>
      <div class="note-content ${state.isReadingMode ? 'reading' : ''}" id="note-body"></div>
      <button class="btn btn-primary btn-block" onclick="App.closeNote()">Back to Map 🗺️</button>
    </div>
  `;

  const body = $('#note-body');
  if (state.isReadingMode) {
    body.innerHTML = renderRichNote(note);
    body.querySelectorAll('.wikilink').forEach(el => {
      el.addEventListener('click', () => navigateToWiki(el.dataset.word));
    });
    body.querySelectorAll('a[data-url]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); window.open(el.dataset.url, '_blank'); });
    });
    body.querySelectorAll('.youtube-preview').forEach(el => {
      el.addEventListener('click', () => window.open(el.dataset.url, '_blank'));
    });
  } else {
    body.innerHTML = `<textarea class="note-editor" id="note-editor">${escapeHtml(note)}</textarea>`;
    $('#note-editor').addEventListener('input', (e) => {
      setNote(pos.word, e.target.value);
    });
  }

  startNoteTimer();
  if (state.isDiaporamaRunning) startDiaporamaProgress();
}

function renderRichNote(text) {
  if (!text) return '<p style="opacity:0.5">No content yet. Switch to edit mode ✍️</p>';

  let html = '';
  const imgPattern = /(?:data:image\/[^;\s]+;base64,[^\s]+|https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)|blob:[^\s]+)/gi;
  const ytPattern = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;

  // Images
  let match;
  const imgs = [...text.matchAll(imgPattern)];
  imgs.forEach(m => {
    html += `<img src="${m[0]}" alt="Note image" loading="lazy">`;
  });

  // YouTube
  const yts = [...text.matchAll(ytPattern)];
  yts.forEach(m => {
    const id = m[1];
    html += `<div class="youtube-preview" data-url="${m[0]}">
      <img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" alt="YouTube">
      <div class="play">▶️</div>
    </div>`;
  });

  // Text (remove image URLs)
  let textOnly = text.replace(imgPattern, '').trim();
  textOnly = escapeHtml(textOnly);

  const combined = /(\*\*([^*]+)\*\*)|(\[\[([^\]]+)\]\])|(https?:\/\/[^\s<]+)/g;
  textOnly = textOnly.replace(combined, (full, _b, bold, _w, wiki, url) => {
    if (bold) return `<strong>${bold}</strong>`;
    if (wiki) return `<span class="wikilink" data-word="${escapeHtml(wiki)}">${escapeHtml(wiki)}</span>`;
    if (url) return `<a href="#" data-url="${url}">${url}</a>`;
    return full;
  });

  html += `<div>${textOnly.replace(/\n/g, '<br>')}</div>`;
  return html;
}

function navigateToWiki(targetWord) {
  const idx = state.positions.findIndex(p => p.word.toLowerCase() === targetWord.toLowerCase());
  if (idx !== -1) {
    const pos = state.positions[idx];
    state.offsetX = -pos.x;
    state.offsetY = -pos.y;
    state.zoom = 1.5;
    state.selected = new Set([idx]);
    openNote(idx);
  } else {
    const current = state.positions[state.editingIndex];
    state.positions.push({ word: targetWord, x: current.x + 200, y: current.y + 200, level: 0 });
    save();
    openNote(state.positions.length - 1);
  }
}

let timerInterval = null;
let timerSeconds = 0;
let timerRunning = true;

function startNoteTimer() {
  clearInterval(timerInterval);
  timerSeconds = 0;
  timerRunning = true;
  timerInterval = setInterval(() => {
    if (timerRunning) {
      timerSeconds++;
      const el = $('#timer-text');
      if (el) {
        const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
        const s = String(timerSeconds % 60).padStart(2, '0');
        el.textContent = `${m}:${s}`;
        if (timerSeconds > 0) $('#btn-reset-timer').style.display = '';
      }
    }
  }, 1000);
}

// ─── History Page ────────────────────────────────────────────────────────────

function openHistoryPage() {
  const page = $('#page-history');
  const formatter = new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' });

  page.innerHTML = `
    <div class="page-header">
      <h1>History</h1>
      <div>
        <button class="btn btn-danger" id="clear-history">Clear</button>
        <button class="btn-icon" id="close-history">❌</button>
      </div>
    </div>
    <div class="page-list" id="history-list">
      ${state.history.length ? state.history.map(e => `
        <div class="list-item" data-word="${escapeHtml(e.word)}">
          <div class="list-item-row">
            <span class="time">${formatter.format(new Date(e.timestamp))}</span>
            <span style="opacity:0.3">|</span>
            <span>${escapeHtml(e.word)}</span>
          </div>
        </div>
      `).join('') : '<p style="text-align:center;opacity:0.5;padding:40px">No history yet</p>'}
    </div>
    <button class="btn btn-primary btn-block" id="close-history-btn">Close</button>
  `;

  page.classList.remove('hidden');
  $('#clear-history').addEventListener('click', () => { state.history = []; save(); openHistoryPage(); });
  $('#close-history, #close-history-btn').addEventListener('click', () => page.classList.add('hidden'));
  page.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = state.positions.findIndex(p => p.word === item.dataset.word);
      if (idx !== -1) { page.classList.add('hidden'); openNote(idx); }
    });
  });
}

// ─── All Notes Page ──────────────────────────────────────────────────────────

function openAllNotesPage() {
  const page = $('#page-all-notes');
  let searchQ = '';
  let autoScroll = false;
  let scrollSpeed = 1;
  let scrollRAF = null;

  function render() {
    const sorted = state.positions
      .map((p, i) => ({ ...p, index: i }))
      .filter(p => p.word.toLowerCase().includes(searchQ.toLowerCase()))
      .sort((a, b) => a.word.localeCompare(b.word));

    const exactMatch = sorted.some(p => p.word.toLowerCase() === searchQ.toLowerCase());

    page.innerHTML = `
      <div class="page-header">
        <h1>All Notes</h1>
        <button class="btn-icon" id="close-all-notes">❌</button>
      </div>
      <input type="text" id="all-notes-search" placeholder="Search in all notes..." value="${escapeHtml(searchQ)}" style="width:100%;padding:12px;border-radius:12px;border:none;background:var(--surface);color:var(--text);margin-bottom:16px;font-size:16px">
      ${searchQ && !exactMatch ? `
        <div class="list-item create" id="create-from-search" style="color:var(--accent);font-weight:600;text-align:center">
          ✨ Create "${escapeHtml(searchQ)}"
        </div>
      ` : ''}
      <div class="page-list" id="all-notes-list" style="max-height:calc(100vh - 280px);overflow-y:auto">
        ${sorted.map(p => `
          <div class="list-item" data-index="${p.index}">
            <div style="text-align:center;font-weight:600">${escapeHtml(p.word)}</div>
          </div>
        `).join('')}
      </div>
      <div class="auto-scroll-bar">
        <button class="btn-icon" id="auto-scroll-toggle">${autoScroll ? '⏸️' : '▶️'}</button>
        <span>Auto-Scroll</span>
        <input type="range" id="scroll-speed" min="0.5" max="30" step="0.5" value="${scrollSpeed}">
        <span id="speed-label">${scrollSpeed}x</span>
      </div>
    `;

    $('#all-notes-search').addEventListener('input', (e) => { searchQ = e.target.value; render(); });
    $('#close-all-notes').addEventListener('click', () => {
      cancelAnimationFrame(scrollRAF);
      page.classList.add('hidden');
    });
    $('#create-from-search')?.addEventListener('click', () => {
      addWord(searchQ, -state.offsetX, -state.offsetY);
      openNote(state.positions.length - 1);
      state.isReadingMode = false;
    });
    page.querySelectorAll('.list-item[data-index]').forEach(item => {
      item.addEventListener('click', () => openNote(+item.dataset.index));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showNoteListActions(+item.dataset.index);
      });
    });
    $('#auto-scroll-toggle').addEventListener('click', () => {
      autoScroll = !autoScroll;
      if (autoScroll) doAutoScroll();
      else cancelAnimationFrame(scrollRAF);
      render();
    });
    $('#scroll-speed').addEventListener('input', (e) => {
      scrollSpeed = +e.target.value;
      $('#speed-label').textContent = scrollSpeed + 'x';
    });
  }

  function doAutoScroll() {
    const list = $('#all-notes-list');
    if (list && autoScroll) {
      list.scrollTop += scrollSpeed;
      scrollRAF = requestAnimationFrame(doAutoScroll);
    }
  }

  page.classList.remove('hidden');
  render();
}

function showNoteListActions(index) {
  const pos = state.positions[index];
  showModal(`Actions for "${escapeHtml(pos.word)}"`, `
    <div class="modal-actions">
      <button class="btn btn-block btn-primary" id="rename-note">✏️ Rename</button>
      <button class="btn btn-block btn-danger" id="delete-note">🗑️ Delete Note</button>
    </div>
  `, [{ label: 'Cancel', action: 'close' }]);

  $('#rename-note').addEventListener('click', () => {
    hideModal();
    showModal('Rename Note', `<input type="text" id="rename-input" value="${escapeHtml(pos.word)}">`, [
      { label: 'Cancel', action: 'close' },
      { label: 'OK', action: 'ok', class: 'btn-primary', onClick: () => {
        const newName = $('#rename-input').value.trim();
        if (newName) {
          const oldNote = getNote(pos.word);
          state.positions.forEach((p, i) => {
            if (p.word === pos.word) state.positions[i].word = newName;
          });
          if (oldNote) { setNote(newName, oldNote); delete state.notes[pos.word.toLowerCase()]; }
          save();
        }
        hideModal();
        openAllNotesPage();
      }},
    ]);
  });
  $('#delete-note').addEventListener('click', () => {
    const word = pos.word;
    state.positions.splice(index, 1);
    removeNotesForWords([word]);
    save({ immediate: true });
    hideModal();
    openAllNotesPage();
  });
}

// ─── Diaporama ───────────────────────────────────────────────────────────────

function openDiaporamaPage() {
  const page = $('#page-diaporama');
  let diaWord = '';

  function render() {
    const suggestions = diaWord
      ? [...new Set(state.positions.map(p => p.word).filter(w => w.toLowerCase().includes(diaWord.toLowerCase())))].slice(0, 3)
      : [];

    page.innerHTML = `
      <div class="page-header">
        <h1>Diaporama</h1>
        <button class="btn-icon" id="close-dia-page">❌</button>
      </div>
      <input type="text" id="dia-add-input" placeholder="Add note to slideshow" value="${escapeHtml(diaWord)}" style="width:100%;padding:12px;border-radius:12px;border:none;background:var(--surface);color:var(--text);margin-bottom:8px;font-size:16px">
      ${suggestions.length ? `<div style="margin-bottom:12px">${suggestions.map(s =>
        `<div class="list-item" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</div>`
      ).join('')}</div>` : ''}
      <div class="page-list">
        ${state.diaporamaList.map((word, i) => `
          <div class="dia-list-item">
            <span class="num">${i + 1}.</span>
            <span class="word">${escapeHtml(word)}</span>
            <button class="btn-icon" data-up="${i}">🔼</button>
            <button class="btn-icon" data-down="${i}">🔽</button>
            <button class="btn-icon" data-remove="${i}">🗑️</button>
          </div>
        `).join('')}
      </div>
      <div class="dia-options">
        <button class="toggle-chip ${state.autoPlayEnabled ? 'active' : ''}" id="toggle-autoplay">Auto-Play (8s)</button>
        <button class="toggle-chip ${state.autoReadEnabled ? 'active' : ''}" id="toggle-autoread">Auto-Read (TTS)</button>
      </div>
      <button class="btn btn-primary btn-block" id="start-dia" ${!state.diaporamaList.length ? 'disabled' : ''}>🚀 Start Diaporama</button>
    `;

    $('#dia-add-input').addEventListener('input', (e) => { diaWord = e.target.value; render(); });
    $('#dia-add-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && diaWord.trim()) {
        state.diaporamaList.push(diaWord.trim());
        diaWord = '';
        save();
        render();
      }
    });
    page.querySelectorAll('[data-suggest]').forEach(el => {
      el.addEventListener('click', () => {
        state.diaporamaList.push(el.dataset.suggest);
        diaWord = '';
        save();
        render();
      });
    });
    page.querySelectorAll('[data-up]').forEach(el => {
      el.addEventListener('click', () => {
        const i = +el.dataset.up;
        if (i > 0) { [state.diaporamaList[i], state.diaporamaList[i - 1]] = [state.diaporamaList[i - 1], state.diaporamaList[i]]; save(); render(); }
      });
    });
    page.querySelectorAll('[data-down]').forEach(el => {
      el.addEventListener('click', () => {
        const i = +el.dataset.down;
        if (i < state.diaporamaList.length - 1) { [state.diaporamaList[i], state.diaporamaList[i + 1]] = [state.diaporamaList[i + 1], state.diaporamaList[i]]; save(); render(); }
      });
    });
    page.querySelectorAll('[data-remove]').forEach(el => {
      el.addEventListener('click', () => { state.diaporamaList.splice(+el.dataset.remove, 1); save(); render(); });
    });
    $('#toggle-autoplay').addEventListener('click', () => { state.autoPlayEnabled = !state.autoPlayEnabled; save(); render(); });
    $('#toggle-autoread').addEventListener('click', () => { state.autoReadEnabled = !state.autoReadEnabled; save(); render(); });
    $('#start-dia').addEventListener('click', startDiaporama);
    $('#close-dia-page').addEventListener('click', () => page.classList.add('hidden'));
  }

  page.classList.remove('hidden');
  render();
}

function startDiaporama() {
  if (!state.diaporamaList.length) return;
  state.currentDiaporamaIndex = 0;
  state.isDiaporamaRunning = true;
  state.isDiaporamaPaused = false;
  $('#page-diaporama').classList.add('hidden');
  $('#diaporama-controls').classList.remove('hidden');

  const word = state.diaporamaList[0];
  const idx = state.positions.findIndex(p => p.word.toLowerCase() === word.toLowerCase());
  if (idx !== -1) openNote(idx);

  updateDiaporamaControls();
  if (state.autoReadEnabled) speakDiaporamaSlide();
  if (state.autoPlayEnabled) scheduleNextSlide();
}

function speakDiaporamaSlide() {
  if (state.editingIndex === -1) return;
  const word = state.positions[state.editingIndex].word;
  const note = getNote(word);
  speak(word);
  if (note) {
    const clean = note.replace(/https?:\/\/\S+/g, '');
    setTimeout(() => speak(clean, false), 500);
  }
}

let diaTimer = null;
function scheduleNextSlide() {
  clearTimeout(diaTimer);
  if (!state.isDiaporamaRunning || state.isDiaporamaPaused) return;

  startDiaporamaProgress();
  diaTimer = setTimeout(() => {
    if (state.currentDiaporamaIndex < state.diaporamaList.length - 1) {
      state.currentDiaporamaIndex++;
      goToDiaporamaSlide(state.currentDiaporamaIndex);
      scheduleNextSlide();
    } else {
      stopDiaporama();
    }
  }, 8000);
}

function goToDiaporamaSlide(index) {
  const word = state.diaporamaList[index];
  const idx = state.positions.findIndex(p => p.word.toLowerCase() === word.toLowerCase());
  if (idx !== -1) {
    state.editingIndex = idx;
    renderNoteView();
    if (state.autoReadEnabled) speakDiaporamaSlide();
  }
  updateDiaporamaControls();
}

function updateDiaporamaControls() {
  $('#dia-counter').textContent = `${state.currentDiaporamaIndex + 1} / ${state.diaporamaList.length}`;
}

function stopDiaporama() {
  state.isDiaporamaRunning = false;
  state.isDiaporamaPaused = false;
  clearTimeout(diaTimer);
  $('#diaporama-controls').classList.add('hidden');
  $('#diaporama-progress').classList.add('hidden');
  closeNote();
}

function startDiaporamaProgress() {
  const bar = $('#diaporama-progress');
  bar.classList.remove('hidden');
  bar.style.width = '0%';
  bar.style.transition = 'none';
  requestAnimationFrame(() => {
    bar.style.transition = 'width 8s linear';
    bar.style.width = '100%';
  });
}

$('#dia-prev').addEventListener('click', () => {
  if (state.currentDiaporamaIndex > 0) {
    state.currentDiaporamaIndex--;
    goToDiaporamaSlide(state.currentDiaporamaIndex);
    if (state.autoPlayEnabled) scheduleNextSlide();
  }
});
$('#dia-next').addEventListener('click', () => {
  if (state.currentDiaporamaIndex < state.diaporamaList.length - 1) {
    state.currentDiaporamaIndex++;
    goToDiaporamaSlide(state.currentDiaporamaIndex);
    if (state.autoPlayEnabled) scheduleNextSlide();
  } else stopDiaporama();
});
$('#dia-pause').addEventListener('click', () => {
  state.isDiaporamaPaused = !state.isDiaporamaPaused;
  $('#dia-pause').textContent = state.isDiaporamaPaused ? '▶️' : '⏸️';
  if (!state.isDiaporamaPaused && state.autoPlayEnabled) scheduleNextSlide();
});
$('#dia-stop').addEventListener('click', stopDiaporama);

// ─── Export ──────────────────────────────────────────────────────────────────

function exportData() {
  const data = {
    positions: state.positions,
    notes: state.notes,
    history: state.history,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mindmap-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  // Export individual notes as text files info
  const noteCount = Object.keys(state.notes).length;
  showToast(`Exported JSON + ${noteCount} notes in data`);
}

// ─── Settings (API Keys) ─────────────────────────────────────────────────────

function openSettingsPage() {
  const page = $('#page-settings');
  page.innerHTML = `
    <div class="page-header">
      <h1>API Settings</h1>
      <button class="btn-icon" id="close-settings">❌</button>
    </div>
    <p style="opacity:0.7;margin-bottom:16px">
      Clés API pour la génération IA (✨). Stockées localement ou dans le fichier <code>.env</code> du serveur.
    </p>
    <label style="display:block;margin-bottom:8px;font-size:14px">DeepSeek API Key</label>
    <input type="password" id="key-deepseek" value="${escapeHtml(state.apiKeys.deepseek)}" style="width:100%;padding:12px;border-radius:8px;border:1px solid rgba(128,128,128,0.3);background:var(--bg);color:var(--text);margin-bottom:16px">
    <label style="display:block;margin-bottom:8px;font-size:14px">OpenAI API Key</label>
    <input type="password" id="key-openai" value="${escapeHtml(state.apiKeys.openai)}" style="width:100%;padding:12px;border-radius:8px;border:1px solid rgba(128,128,128,0.3);background:var(--bg);color:var(--text);margin-bottom:16px">
    <button class="btn btn-primary btn-block" id="save-settings">Save</button>
    <button class="btn btn-secondary btn-block" id="import-data" style="margin-top:12px">📂 Import JSON</button>
    <input type="file" id="import-file" accept=".json" style="display:none">
  `;
  page.classList.remove('hidden');

  $('#close-settings').addEventListener('click', () => page.classList.add('hidden'));
  $('#save-settings').addEventListener('click', () => {
    state.apiKeys.deepseek = $('#key-deepseek').value.trim();
    state.apiKeys.openai = $('#key-openai').value.trim();
    save();
    showToast('Settings saved');
    page.classList.add('hidden');
  });
  $('#import-data').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.positions) state.positions = data.positions;
        if (data.notes) state.notes = data.notes;
        if (data.history) state.history = data.history;
        save();
        render();
        showToast('Import successful');
        page.classList.add('hidden');
      } catch (err) {
        showToast('Import failed: invalid JSON');
      }
    };
    reader.readAsText(file);
  });
}

// ─── AI Generation ───────────────────────────────────────────────────────────

async function generateAI() {
  if (state.isAiGenerating || state.editingIndex === -1) return;

  if (!Sync.isServerMode()) {
    showToast('Lancez le serveur pour utiliser l\'IA');
    return;
  }

  state.isAiGenerating = true;
  renderNoteView();
  const word = state.positions[state.editingIndex].word;

  try {
    const res = await fetch('/api/ai/generate', {
      method: 'POST',
      headers: Sync.headers,
      body: JSON.stringify({
        word,
        deepseekKey: state.apiKeys.deepseek || undefined,
        openaiKey: state.apiKeys.openai || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

    if (data.note) {
      setNote(word, data.note);
      const msg = data.warnings?.length
        ? `Note générée (${data.warnings.length} avertissement)`
        : 'Génération IA terminée ✨';
      showToast(msg);
      renderNoteView();
    } else {
      showToast('Génération échouée');
    }
  } catch (e) {
    showToast(`Erreur IA: ${e.message}`);
    console.error('AI error:', e);
    if (e.message.includes('Clés API')) openSettingsPage();
  } finally {
    state.isAiGenerating = false;
    renderNoteView();
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function closeNote() {
  state.editingIndex = -1;
  clearInterval(timerInterval);
  $('#page-note').classList.add('hidden');
  render();
}

function pickImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const word = state.positions[state.editingIndex].word;
      const current = getNote(word);
      setNote(word, current ? `${current}\n${ev.target.result}` : ev.target.result);
      renderNoteView();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function insertWikilink() {
  state.isReadingMode = false;
  renderNoteView();
  const editor = $('#note-editor');
  if (!editor) return;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const text = editor.value;
  const selected = text.substring(start, end);
  const insert = selected ? `[[${selected}]]` : '[[]]';
  editor.value = text.substring(0, start) + insert + text.substring(end);
  const word = state.positions[state.editingIndex].word;
  setNote(word, editor.value);
  editor.focus();
  editor.selectionStart = editor.selectionEnd = start + (selected ? selected.length + 4 : 2);
}

// ─── Public API ──────────────────────────────────────────────────────────────

window.App = {
  closeNote,
  toggleMode: () => { state.isReadingMode = !state.isReadingMode; renderNoteView(); },
  speakTitle: () => speak(state.positions[state.editingIndex]?.word),
  speakNote: () => speak(getNote(state.positions[state.editingIndex]?.word)),
  googleSearch: () => window.open(`https://www.google.com/search?q=${encodeURIComponent(state.positions[state.editingIndex].word)}`, '_blank'),
  googleImages: () => window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(state.positions[state.editingIndex].word)}`, '_blank'),
  googleMaps: () => window.open(`https://www.google.com/maps/search/${encodeURIComponent(state.positions[state.editingIndex].word)}`, '_blank'),
  pickImage,
  insertWikilink,
  generateAI,
  toggleTimer: () => { timerRunning = !timerRunning; },
  resetTimer: () => { timerSeconds = 0; timerRunning = false; },
};

// ─── Backup ──────────────────────────────────────────────────────────────────

function openBackupPage() {
  const page = $('#page-account');

  async function render() {
    let backups = [];
    let storage = {};
    try {
      const [backupsRes, healthRes] = await Promise.all([
        fetch('/api/data/backups', { headers: Sync.headers }),
        fetch('/api/health', { headers: Sync.headers }),
      ]);
      const backupsData = await backupsRes.json();
      const healthData = await healthRes.json();
      backups = backupsData.backups || [];
      storage = healthData.storage || {};
    } catch { /* ignore */ }

    const storageWarning = storage.persistent
      ? '☁️ Stockage persistant actif sur le serveur.'
      : '⚠️ Disque non persistant — risque de perte. Passez au plan Starter Render.';

    page.innerHTML = `
      <div class="page-header">
        <h1>Sauvegarde</h1>
        <button class="btn-icon" id="close-backup">❌</button>
      </div>
      <p style="opacity:0.7;font-size:14px;margin-bottom:16px">${storageWarning}</p>
      <button class="btn btn-primary btn-block" id="btn-cloud-backup" style="margin-bottom:8px">📥 Télécharger ma sauvegarde</button>
      <button class="btn btn-secondary btn-block" id="btn-cloud-restore" style="margin-bottom:16px">📂 Restaurer un fichier JSON</button>
      <input type="file" id="restore-file" accept=".json" style="display:none">
      <h3 style="margin-bottom:8px">Sauvegardes automatiques (${backups.length})</h3>
      <div class="page-list" id="server-backups-list" style="max-height:40vh;overflow-y:auto">
        ${backups.length ? backups.map((b) => `
          <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <div>
              <div style="font-weight:600">${b.wordCount} mot(s), ${b.noteCount} note(s)</div>
              <div style="opacity:0.6;font-size:12px">${b.updated_at ? new Date(b.updated_at).toLocaleString('fr-FR') : b.filename}</div>
            </div>
            <button class="btn btn-secondary" data-restore-backup="${escapeHtml(b.filename)}">Restaurer</button>
          </div>
        `).join('') : `<p style="opacity:0.5;padding:12px">Aucune sauvegarde avec des données.<br><br>Les sauvegardes automatiques sont créées à chaque modification. Si la liste est vide, les données ont peut‑être été perdues lors d'un redémarrage Render (plan gratuit).<br><br>Vérifiez aussi le cache de votre navigateur sur un autre appareil — vos notes peuvent encore y être.</p>`}
      </div>
    `;

    $('#close-backup').addEventListener('click', () => page.classList.add('hidden'));
    $('#btn-cloud-backup').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/data/backup', { headers: Sync.headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mindmap-backup-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Sauvegarde téléchargée');
      } catch (e) {
        showToast('Erreur: ' + e.message);
      }
    });
    $('#btn-cloud-restore').addEventListener('click', () => $('#restore-file').click());
    $('#restore-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const res = await fetch('/api/data/restore', {
          method: 'POST',
          headers: Sync.headers,
          body: JSON.stringify(data),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        const serverData = await Sync.fetchData();
        applyData(serverData);
        Sync.setServerTimestamp(serverData.updated_at);
        startApp();
        showToast('Sauvegarde restaurée ✓');
        page.classList.add('hidden');
      } catch (err) {
        showToast('Erreur: ' + err.message);
      }
    });
    page.querySelectorAll('[data-restore-backup]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.restoreBackup;
        if (!confirm(`Restaurer la sauvegarde du ${btn.closest('.list-item').querySelector('div div:last-child')?.textContent || filename} ?`)) return;
        try {
          const res = await fetch('/api/data/restore-backup', {
            method: 'POST',
            headers: Sync.headers,
            body: JSON.stringify({ filename }),
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error);
          const serverData = await Sync.fetchData();
          applyData(serverData);
          Sync.setServerTimestamp(serverData.updated_at);
          startApp();
          showToast(`Restauré : ${result.wordCount} mots, ${result.noteCount} notes ✓`);
          page.classList.add('hidden');
        } catch (err) {
          showToast('Erreur: ' + err.message);
        }
      });
    });
  }

  page.classList.remove('hidden');
  render();
}

async function loadFromServer() {
  try {
    const serverData = await Sync.fetchData();

    // Le serveur est la source de vérité dès qu'il a été synchronisé au moins une fois
    if (serverData.updated_at) {
      applyData(serverData);
      persistLocal(serverData.updated_at);
      Sync.setServerTimestamp(serverData.updated_at);
      return;
    }

    // Premier démarrage : migrer les données locales vers le serveur si elles existent
    let localData = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) localData = JSON.parse(raw);
    } catch { /* ignore */ }

    const localHasData =
      (localData?.positions?.length > 0) || (Object.keys(localData?.notes || {}).length > 0);

    if (localHasData) {
      applyData(localData);
      await Sync.pushData(getSyncPayload());
      persistLocal(new Date().toISOString());
    } else {
      initDefaultData();
    }
  } catch (e) {
    load();
    console.error('Server load failed, using local:', e);
  }
}

function startApp() {
  document.body.classList.toggle('light', !state.isDark);
  document.body.classList.toggle('dark', state.isDark);
  $('#btn-theme').textContent = state.isDark ? '☀️' : '🌙';
  resizeCanvas();
  render();
}

async function bootstrap() {
  if (Sync.isServerMode()) {
    await loadFromServer();
    Sync.startPolling((data) => {
      if (state.editingIndex !== -1 || state.isAiGenerating) return;
      applyData(data);
      persistLocal(data.updated_at);
      render();
    });
  } else {
    load();
  }
  startApp();
}

// ─── Init ──────────────────────────────────────────────────────────────────────

bootstrap();
window.addEventListener('resize', resizeCanvas);

// Keyboard shortcut: Escape closes overlays
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal-overlay').classList.contains('hidden')) hideModal();
    else if (state.editingIndex !== -1) closeNote();
    else {
      $$('.page-overlay').forEach(p => p.classList.add('hidden'));
    }
  }
});
