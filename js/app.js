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
  noteDates: {},      // word (lowercase) -> ISO createdAt
  folders: [],        // { id, name, createdAt }
  noteFolders: {},    // word (lowercase) -> folder id
  deletions: {},      // word (lowercase) -> deletion timestamp (ms) [tombstones]
  wordTimes: {},      // word (lowercase) -> last note edit timestamp (ms)
  posTimes: {},       // word (lowercase) -> last position change timestamp (ms)
  folderTimes: {},    // folder id -> last create/rename timestamp (ms)
  folderDeletions: {},// folder id -> deletion timestamp (ms) [tombstones]
  noteFolderTimes: {},// word (lowercase) -> last folder-assignment change timestamp (ms)
};

// ─── DOM ─────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('mindmap-canvas');
const ctx = canvas.getContext('2d');
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mindmap_data';
const DEFAULT_TITLE = 'All Notes';
const dirtyNoteKeys = new Set();

function getProtectedNoteKeys() {
  const keys = new Set(dirtyNoteKeys);
  if (state.editingIndex !== -1) {
    const word = state.positions[state.editingIndex]?.word;
    if (word) keys.add(word.toLowerCase());
  }
  return keys;
}

function clearDirtyNoteKeys(keys) {
  if (keys) {
    Object.keys(keys).forEach((k) => dirtyNoteKeys.delete(k.toLowerCase()));
  } else {
    dirtyNoteKeys.clear();
  }
}

function noteUrl(word, edit = false) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('note', word);
  if (edit) url.searchParams.set('edit', '1');
  return url.toString();
}

function openNoteInNewTab(index, edit = false) {
  const word = state.positions[index]?.word;
  if (!word) return;
  window.open(noteUrl(word, edit), '_blank');
}

function isDedicatedNoteTab() {
  return new URLSearchParams(location.search).has('note');
}

function folderUrl(folderId) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('folder', folderId);
  return url.toString();
}

function openFolderInNewTab(folderId) {
  if (!folderId) return;
  window.open(folderUrl(folderId), '_blank');
}

function isDedicatedFolderTab() {
  return new URLSearchParams(location.search).has('folder');
}

function openNoteFromUrl() {
  const params = new URLSearchParams(location.search);
  const noteWord = params.get('note')?.trim();
  if (!noteWord) return false;

  let idx = state.positions.findIndex(
    (p) => p.word.toLowerCase() === noteWord.toLowerCase(),
  );

  // Note créée dans l'autre onglet — pas encore sur le serveur
  if (idx === -1) {
    addWord(noteWord, -state.offsetX, -state.offsetY);
    idx = state.positions.findIndex(
      (p) => p.word.toLowerCase() === noteWord.toLowerCase(),
    );
    if (idx === -1) return false;
  }

  state.isReadingMode = params.get('edit') !== '1';
  document.body.classList.remove('home-view');
  openNote(idx);
  return true;
}

function returnToAllNotes() {
  document.body.classList.remove('note-view', 'note-tab');
  document.body.classList.add('home-view');
  document.body.classList.remove('map-view');
  openAllNotesPage();
}

function openFolderFromUrl() {
  const params = new URLSearchParams(location.search);
  const folderId = params.get('folder')?.trim();
  if (!folderId) return false;

  document.body.classList.add('folder-tab');
  document.body.classList.remove('map-view');
  allNotesUI.currentFolderId = folderId;
  allNotesUI.searchQ = '';
  const folder = getFolderById(folderId);
  document.title = folder ? folder.name : 'Dossier';
  openAllNotesPage();
  return true;
}

// Ferme la vue dossier avec le même comportement que la croix des notes.
async function closeFolder() {
  const dedicatedTab = isDedicatedFolderTab();
  allNotesUI.currentFolderId = null;
  document.body.classList.remove('folder-tab');

  if (dedicatedTab) {
    try {
      if (window.opener && !window.opener.closed) window.opener.focus();
    } catch (_) { /* ignore */ }
    window.close();
    setTimeout(() => {
      if (document.hidden) return;
      history.replaceState({ view: 'all-notes' }, '', location.pathname);
      openAllNotesPage();
    }, 150);
    return;
  }
  openAllNotesPage();
}

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
      noteDates: state.noteDates,
      folders: state.folders,
      noteFolders: state.noteFolders,
      deletions: state.deletions,
      wordTimes: state.wordTimes,
      posTimes: state.posTimes,
      folderTimes: state.folderTimes,
      folderDeletions: state.folderDeletions,
      noteFolderTimes: state.noteFolderTimes,
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
  state.noteDates = s.noteDates || data.noteDates || {};
  state.folders = s.folders || data.folders || [];
  state.noteFolders = s.noteFolders || data.noteFolders || {};
  state.deletions = s.deletions || data.deletions || {};
  state.wordTimes = s.wordTimes || data.wordTimes || {};
  state.posTimes = s.posTimes || data.posTimes || {};
  state.folderTimes = s.folderTimes || data.folderTimes || {};
  state.folderDeletions = s.folderDeletions || data.folderDeletions || {};
  state.noteFolderTimes = s.noteFolderTimes || data.noteFolderTimes || {};
  state.apiKeys = { deepseek: '', openai: '' };
  Object.keys(state.notes).forEach((key) => {
    state.notes[key] = noteToPlain(state.notes[key]);
  });
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
    noteDates: state.noteDates,
    folders: state.folders,
    noteFolders: state.noteFolders,
    deletions: state.deletions,
    wordTimes: state.wordTimes,
    posTimes: state.posTimes,
    folderTimes: state.folderTimes,
    folderDeletions: state.folderDeletions,
    noteFolderTimes: state.noteFolderTimes,
    apiKeys: state.apiKeys,
    _updatedAt: updatedAt || new Date().toISOString(),
  };
}

function persistLocal(updatedAt) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildLocalData(updatedAt)));
  } catch (e) {
    console.error('localStorage save failed:', e);
    showToast('Stockage local plein — sauvegarde cloud…');
  }
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
  if (Sync.lastServerSnapshot) {
    state.positions = mergePositions(Sync.lastServerSnapshot.positions, state.positions);
    applyMergedSettings(Sync.lastServerSnapshot.settings, getSyncPayload().settings);
    // Purge les mots supprimés/renommés que l'union avec l'instantané serveur
    // vient de ressusciter (sinon un renommage ou une suppression est annulé).
    applyTombstones();
  }
  pruneOrphanNotes();
  const updatedAt = new Date().toISOString();
  persistLocal(updatedAt);
  if (Sync.isServerMode()) {
    Sync.lastPayload = getSyncPayload();
    Sync.scheduleSync(getSyncPayload, options.immediate);
  }
}

function mergeNotesKeepLonger(localNotes, incomingNotes) {
  const merged = { ...(incomingNotes || {}) };
  Object.entries(localNotes || {}).forEach(([key, content]) => {
    const existing = merged[key] || '';
    if ((content?.length || 0) > (existing?.length || 0)) {
      merged[key] = content;
    }
  });
  return merged;
}

function mergePositions(...sources) {
  const byKey = new Map();
  sources.forEach((positions) => {
    (positions || []).forEach((pos) => {
      if (!pos?.word) return;
      const key = pos.word.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, pos);
    });
  });
  return Array.from(byKey.values());
}

function getSettingsFromStored(data) {
  if (!data) return {};
  const s = data.settings || data;
  return {
    folders: s.folders || data.folders || [],
    noteFolders: s.noteFolders || data.noteFolders || {},
    noteDates: s.noteDates || data.noteDates || {},
    diaporamaList: s.diaporamaList || data.diaporamaList || [],
    deletions: s.deletions || data.deletions || {},
    wordTimes: s.wordTimes || data.wordTimes || {},
    posTimes: s.posTimes || data.posTimes || {},
    folderTimes: s.folderTimes || data.folderTimes || {},
    folderDeletions: s.folderDeletions || data.folderDeletions || {},
    noteFolderTimes: s.noteFolderTimes || data.noteFolderTimes || {},
    zoom: s.zoom ?? data.zoom,
    offsetX: s.offsetX ?? data.offsetX,
    offsetY: s.offsetY ?? data.offsetY,
    isDark: s.isDark ?? data.isDark,
  };
}

function applyMergedSettings(...settingsSources) {
  const merged = mergeSettings(...settingsSources);
  state.folders = merged.folders || [];
  state.noteFolders = merged.noteFolders || {};
  state.noteDates = merged.noteDates || {};
  state.diaporamaList = merged.diaporamaList || [];
  state.deletions = merged.deletions || {};
  state.wordTimes = merged.wordTimes || {};
  state.posTimes = merged.posTimes || {};
  state.folderTimes = merged.folderTimes || {};
  state.folderDeletions = merged.folderDeletions || {};
  state.noteFolderTimes = merged.noteFolderTimes || {};
  if (merged.zoom != null) state.zoom = merged.zoom;
  if (merged.offsetX != null) state.offsetX = merged.offsetX;
  if (merged.offsetY != null) state.offsetY = merged.offsetY;
  if (merged.isDark != null) state.isDark = merged.isDark;
}

function mergeRemoteState(localStored, serverData, opts = {}) {
  const preferLocal = opts.preferLocal || false;
  const protectedKeys = opts.protectedKeys || getProtectedNoteKeys();
  const tiebreak = preferLocal ? 'local' : 'server';

  // Côté local = état courant en mémoire (source la plus fraîche), avec ses horodatages.
  const localSide = getSyncPayload().settings;
  const serverSide = serverData?.settings || {};
  const localNotes = { ...(localStored?.notes || {}), ...state.notes };

  state.notes = mergeNotesByTime(
    localNotes, serverData?.notes,
    localSide.wordTimes, serverSide.wordTimes,
    protectedKeys, tiebreak,
  );
  state.positions = mergePositionsByTime(
    state.positions, serverData?.positions,
    localSide.posTimes, serverSide.posTimes, tiebreak,
  );
  // La dernière source l'emporte sur égalité d'horodatage : local si preferLocal.
  applyMergedSettings(...(preferLocal ? [serverSide, localSide] : [localSide, serverSide]));
  state.history = mergeHistory(serverData?.history, localStored?.history);
  applyTombstones();
}

function remoteDataWasEnriched(localStored, serverData) {
  if (notesWereMerged(localStored?.notes, serverData?.notes)) return true;

  const localSettings = getSettingsFromStored(localStored);
  const serverSettings = serverData?.settings || {};
  if (mergeFolders(localSettings.folders, serverSettings.folders).length
    > (serverSettings.folders?.length || 0)) return true;
  if (Object.keys(mergeNoteFolders(localSettings.noteFolders, serverSettings.noteFolders)).length
    > Object.keys(serverSettings.noteFolders || {}).length) return true;
  if (mergePositions(localStored?.positions, serverData?.positions).length
    > (serverData?.positions?.length || 0)) return true;
  if (mergeHistory(localStored?.history, serverData?.history).length
    > (serverData?.history?.length || 0)) return true;

  return false;
}

function notesWereMerged(localNotes, incomingNotes) {
  const merged = mergeNotesKeepLonger(localNotes, incomingNotes);
  return Object.keys(merged).some((key) => (merged[key] || '') !== (incomingNotes?.[key] || ''));
}

function pruneOrphanNotes() {
  const words = new Set(state.positions.map((p) => p.word.toLowerCase()));
  Object.keys(state.notes).forEach((key) => {
    if (!words.has(key)) delete state.notes[key];
  });
  Object.keys(state.noteDates).forEach((key) => {
    if (!words.has(key)) delete state.noteDates[key];
  });
  Object.keys(state.noteFolders).forEach((key) => {
    if (!words.has(key)) delete state.noteFolders[key];
  });
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getFolderById(id) {
  return state.folders.find((f) => f.id === id);
}

function countNotesInFolder(folderId) {
  return Object.values(state.noteFolders).filter((fid) => fid === folderId).length;
}

function createFolder(name) {
  const folder = { id: generateId(), name: name.trim(), createdAt: new Date().toISOString() };
  state.folders.push(folder);
  state.folders.sort((a, b) => a.name.localeCompare(b.name));
  state.folderTimes[folder.id] = Date.now();
  delete state.folderDeletions[folder.id];
  save();
  return folder;
}

function deleteFolder(folderId) {
  state.folders = state.folders.filter((f) => f.id !== folderId);
  Object.keys(state.noteFolders).forEach((key) => {
    if (state.noteFolders[key] === folderId) {
      state.noteFolders[key] = null;
      state.noteFolderTimes[key] = Date.now();
    }
  });
  state.folderDeletions[folderId] = Date.now();
  delete state.folderTimes[folderId];
  save();
}

function renameFolder(folderId, newName) {
  const folder = getFolderById(folderId);
  if (folder) {
    folder.name = newName.trim();
    state.folders.sort((a, b) => a.name.localeCompare(b.name));
    state.folderTimes[folderId] = Date.now();
    save();
  }
}

function getNoteFolderId(word) {
  return state.noteFolders[word.toLowerCase()] || null;
}

function setNoteFolder(word, folderId) {
  const key = word.toLowerCase();
  // On conserve la clé (avec null) pour propager la désaffectation aux autres appareils.
  state.noteFolders[key] = folderId || null;
  state.noteFolderTimes[key] = Date.now();
  save();
}

function renameNoteFolderKey(oldWord, newWord) {
  const oldKey = oldWord.toLowerCase();
  const newKey = newWord.toLowerCase();
  if (state.noteFolders[oldKey]) {
    state.noteFolders[newKey] = state.noteFolders[oldKey];
    state.noteFolderTimes[newKey] = Date.now();
    state.noteFolders[oldKey] = null;
    state.noteFolderTimes[oldKey] = Date.now();
  }
}

function ensureNoteDate(word) {
  const key = word.toLowerCase();
  if (!state.noteDates[key]) {
    state.noteDates[key] = new Date().toISOString();
  }
}

function getNoteDate(word) {
  return state.noteDates[word.toLowerCase()] || null;
}

function renameNoteDate(oldWord, newWord) {
  const oldKey = oldWord.toLowerCase();
  const newKey = newWord.toLowerCase();
  if (state.noteDates[oldKey] && !state.noteDates[newKey]) {
    state.noteDates[newKey] = state.noteDates[oldKey];
  }
  delete state.noteDates[oldKey];
}

function formatNoteDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function renderNoteDateFooter(word) {
  const createdAt = getNoteDate(word);
  if (!createdAt) return '';
  return `<p class="note-created-at">Créée le ${formatNoteDate(createdAt)}</p>`;
}

function removeNotesForWords(words) {
  words.forEach((word) => {
    const key = word.toLowerCase();
    const stillUsed = state.positions.some((p) => p.word.toLowerCase() === key);
    if (!stillUsed) {
      delete state.notes[key];
      delete state.noteDates[key];
      delete state.noteFolders[key];
      recordDeletion(word);
    }
  });
}

// Marque un mot comme supprimé pour propager la suppression aux autres appareils.
function recordDeletion(word) {
  const key = word.toLowerCase();
  state.deletions[key] = Date.now();
  delete state.wordTimes[key];
}

// Marque une activité utilisateur (création/édition) sur un mot : annule un éventuel tombstone.
function touchWord(word) {
  if (!word) return;
  const key = word.toLowerCase();
  state.wordTimes[key] = Date.now();
  delete state.deletions[key];
}

// Marque un changement de position (création/déplacement) d'un mot.
function touchPos(word) {
  if (!word) return;
  state.posTimes[word.toLowerCase()] = Date.now();
}

/**
 * Applique les tombstones : retire des positions/notes tout mot supprimé,
 * sauf si une activité utilisateur plus récente (wordTimes) l'a recréé.
 * Nettoie aussi les tombstones expirés (> 60 jours) pour limiter la taille.
 */
function applyTombstones() {
  const deletions = state.deletions || {};
  const wordTimes = state.wordTimes || {};
  const EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const dead = new Set();

  Object.entries(deletions).forEach(([key, delTs]) => {
    if (now - delTs > EXPIRY_MS) {
      delete deletions[key];
      return;
    }
    if ((wordTimes[key] || 0) > delTs) {
      delete deletions[key];
    } else {
      dead.add(key);
    }
  });

  if (dead.size) {
    state.positions = state.positions.filter((p) => !dead.has(p.word.toLowerCase()));
    dead.forEach((key) => {
      delete state.notes[key];
      delete state.noteDates[key];
      delete state.noteFolders[key];
    });
    state.diaporamaList = (state.diaporamaList || []).filter((w) => !dead.has(w.toLowerCase()));
  }

  applyFolderTombstones();
}

/**
 * Applique les tombstones de dossiers : retire un dossier supprimé sauf s'il
 * a été recréé/renommé plus récemment (folderTimes). Les notes affectées à un
 * dossier mort repassent en "non classé".
 */
function applyFolderTombstones() {
  const folderDeletions = state.folderDeletions || {};
  const folderTimes = state.folderTimes || {};
  const EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const deadFolders = new Set();

  Object.entries(folderDeletions).forEach(([id, delTs]) => {
    if (now - delTs > EXPIRY_MS) {
      delete folderDeletions[id];
      return;
    }
    if ((folderTimes[id] || 0) > delTs) {
      delete folderDeletions[id];
    } else {
      deadFolders.add(id);
    }
  });

  if (!deadFolders.size) return;
  state.folders = (state.folders || []).filter((f) => !deadFolders.has(f.id));
  Object.keys(state.noteFolders).forEach((key) => {
    if (deadFolders.has(state.noteFolders[key])) state.noteFolders[key] = null;
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
  return noteToPlain(state.notes[word.toLowerCase()] || '');
}

function setNote(word, content, options = {}) {
  const key = word.toLowerCase();
  state.notes[key] = noteToPlain(content);
  dirtyNoteKeys.add(key);
  touchWord(word);
  save(options);
}

function noteToPlain(text) {
  if (!text) return '';
  return text.replace(/\[\[([^\]]+)\]\]/g, '$1');
}

function isLinkBoundaryBefore(ch) {
  return ch === undefined || /\s/.test(ch) || /[.,;:!?«»"'([{—\-…]/.test(ch);
}

function isLinkBoundaryAfter(ch) {
  return ch === undefined || /\s/.test(ch) || /[.,;:!?»"')\]}—\-…]/.test(ch);
}

function linkifyPlainText(plain) {
  const words = getAllMindmapWords().sort((a, b) => b.length - a.length);
  let html = '';
  let i = 0;

  while (i < plain.length) {
    const ch = plain[i];

    if (ch === '\n') {
      html += '<br>';
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      html += ch;
      i += 1;
      continue;
    }

    let linked = false;
    for (const word of words) {
      if (plain.length - i < word.length) continue;
      if (plain.substring(i, i + word.length).toLowerCase() !== word.toLowerCase()) continue;

      const before = i > 0 ? plain[i - 1] : undefined;
      const after = plain[i + word.length];
      if (!isLinkBoundaryBefore(before) || !isLinkBoundaryAfter(after)) continue;

      const canonical = getCanonicalWord(word);
      const slice = plain.substring(i, i + word.length);
      html += `<span class="wikilink" data-word="${escapeHtml(canonical)}">${escapeHtml(slice)}</span>`;
      i += word.length;
      linked = true;
      break;
    }

    if (!linked) {
      const m = plain.slice(i).match(/^[\p{L}\p{N}'’\-]+/u);
      if (m) {
        html += escapeHtml(m[0]);
        i += m[0].length;
      } else {
        html += escapeHtml(ch);
        i += 1;
      }
    }
  }

  return html;
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
  state.positions.forEach((p) => { ensureNoteDate(p.word); touchWord(p.word); touchPos(p.word); });
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
      openNote(index, { newTab: true });
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
  ensureNoteDate(word);
  touchWord(word);
  touchPos(word);
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
      touchWord(p.word);
      touchPos(p.word);
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
      touchPos(state.positions[i].word);
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
$('#btn-all-notes').addEventListener('click', () => {
  if (document.body.classList.contains('home-view')) {
    showMapView();
  } else {
    openAllNotesPage();
  }
});
$('#btn-export').addEventListener('click', exportData);
$('#btn-settings').addEventListener('click', openSettingsPage);
$('#btn-backup').addEventListener('click', openBackupPage);

// ─── Note View ───────────────────────────────────────────────────────────────

function showNoteLoadingShell() {
  document.body.classList.add('note-tab');
  document.body.classList.remove('home-view', 'map-view', 'note-view');
  const page = $('#page-note');
  if (!page) return;
  page.innerHTML = '<div class="note-view note-loading">Chargement de la note…</div>';
  page.classList.remove('hidden');
}

function openNote(index, { newTab = false, edit = false } = {}) {
  if (newTab) {
    openNoteInNewTab(index, edit);
    return;
  }

  $$('.page-overlay').forEach((overlay) => {
    if (overlay.id !== 'page-note') overlay.classList.add('hidden');
  });
  document.body.classList.remove('home-view', 'map-view');
  document.body.classList.add('note-view');

  state.editingIndex = index;
  if (edit) state.isReadingMode = false;
  const word = state.positions[index].word;

  addHistory(word);
  speak(word);
  document.title = word;
  renderNoteView();
  $('#page-note').classList.remove('hidden');
}

function addHistory(word) {
  state.history.unshift({ word, timestamp: Date.now() });
  if (state.history.length > 100) state.history.length = 100;
  save();
}

// ─── Image lightbox ──────────────────────────────────────────────────────────

const imageViewer = {
  scale: 1,
  x: 0,
  y: 0,
  bound: false,
  pinchStartDist: 0,
  pinchStartScale: 1,
};

function applyImageViewerTransform() {
  const img = $('#image-lightbox-img');
  const label = $('#img-zoom-level');
  if (!img) return;
  img.style.transform = `translate(${imageViewer.x}px, ${imageViewer.y}px) scale(${imageViewer.scale})`;
  if (label) label.textContent = `${Math.round(imageViewer.scale * 100)}%`;
}

function resetImageViewerTransform() {
  imageViewer.scale = 1;
  imageViewer.x = 0;
  imageViewer.y = 0;
  applyImageViewerTransform();
}

function setImageViewerScale(next) {
  imageViewer.scale = Math.max(0.5, Math.min(8, next));
  applyImageViewerTransform();
}

function ensureImageLightbox() {
  if (imageViewer.bound) return;
  const lb = $('#image-lightbox');
  const stage = $('#image-lightbox-stage');
  const img = $('#image-lightbox-img');
  if (!lb || !stage || !img) return;

  $('#image-lightbox-close')?.addEventListener('click', closeImageLightbox);
  $('#img-zoom-in')?.addEventListener('click', () => setImageViewerScale(imageViewer.scale * 1.25));
  $('#img-zoom-out')?.addEventListener('click', () => setImageViewerScale(imageViewer.scale / 1.25));
  $('#img-zoom-reset')?.addEventListener('click', resetImageViewerTransform);

  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target === stage) closeImageLightbox();
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setImageViewerScale(imageViewer.scale * factor);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target !== img) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.classList.add('is-dragging');
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    if (!dragging) return;
    imageViewer.x += e.clientX - lastX;
    imageViewer.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyImageViewerTransform();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('is-dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      imageViewer.pinchStartDist = Math.hypot(dx, dy);
      imageViewer.pinchStartScale = imageViewer.scale;
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !imageViewer.pinchStartDist) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    setImageViewerScale(imageViewer.pinchStartScale * (dist / imageViewer.pinchStartDist));
  }, { passive: false });

  stage.addEventListener('touchend', () => {
    imageViewer.pinchStartDist = 0;
  });

  imageViewer.bound = true;
}

function openImageLightbox(src) {
  ensureImageLightbox();
  const lb = $('#image-lightbox');
  const img = $('#image-lightbox-img');
  if (!lb || !img) return;
  img.src = src;
  resetImageViewerTransform();
  lb.classList.remove('hidden');
  lb.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeImageLightbox() {
  const lb = $('#image-lightbox');
  if (!lb || lb.classList.contains('hidden')) return;
  lb.classList.add('hidden');
  lb.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const img = $('#image-lightbox-img');
  if (img) img.removeAttribute('src');
}

function renderNoteView() {
  if (state.editingIndex === -1) return;
  const pos = state.positions[state.editingIndex];
  const note = getNote(pos.word);
  const page = $('#page-note');
  document.title = pos.word;

  page.innerHTML = `
    <div class="note-view">
      ${state.isDiaporamaRunning ? '<div class="diaporama-progress" id="note-dia-progress" style="position:relative;height:3px;background:var(--accent);width:0%"></div>' : ''}
      <div class="page-header">
        <div style="flex:1">
          <div class="note-title">${escapeHtml(pos.word)}</div>
        </div>
        <button type="button" class="btn-icon" onclick="App.closeNote()">❌</button>
      </div>
      <div class="note-content ${state.isReadingMode ? 'reading' : ''}" id="note-body"></div>
      <div class="note-toolbar note-toolbar-floating">
        <button onclick="App.googleSearch()" title="Google">🔍</button>
        <button onclick="App.googleImages()" title="Images">🖼️</button>
        <button onclick="App.googleMaps()" title="Maps">📍</button>
        <button onclick="App.speakTitle()" title="TTS Title">📢</button>
        <button onclick="App.speakNote()" title="TTS Note">📝🔊</button>
        <button onclick="App.pickImage()" title="Photo">📷</button>
        <button onclick="App.toggleMode()" title="Mode">${state.isReadingMode ? '✍️' : '📖'}</button>
        <button onclick="App.generateAI()" title="AI" id="btn-ai">${state.isAiGenerating ? '<span class="spinner"></span>' : '✨'}</button>
        <div class="timer" id="note-timer" onclick="App.toggleTimer()">⏱️ <span id="timer-text">00:00</span></div>
        <button onclick="App.resetTimer()" id="btn-reset-timer" style="display:none">🔄</button>
      </div>
    </div>
  `;

  const body = $('#note-body');
  const dateFooter = renderNoteDateFooter(pos.word);
  if (state.isReadingMode) {
    body.innerHTML = renderRichNote(note) + dateFooter;
    body.addEventListener('click', (e) => {
      const noteImg = e.target.closest('img.note-image');
      if (noteImg?.src) {
        e.preventDefault();
        openImageLightbox(noteImg.src);
        return;
      }
      const link = e.target.closest('.wikilink');
      if (link?.dataset.word) {
        e.preventDefault();
        navigateToWiki(link.dataset.word);
        return;
      }
      const urlLink = e.target.closest('a[data-url]');
      if (urlLink) {
        e.preventDefault();
        window.open(urlLink.dataset.url, '_blank');
        return;
      }
      const yt = e.target.closest('.youtube-preview');
      if (yt?.dataset.url) {
        window.open(yt.dataset.url, '_blank');
      }
    });
  } else {
    body.innerHTML = `
      <div class="note-editor-wrap">
        <textarea class="note-editor" id="note-editor">${escapeHtml(note)}</textarea>
        <div id="wiki-suggestions" class="wiki-suggestions hidden"></div>
      </div>${dateFooter}`;
    const editor = $('#note-editor');
    editor.addEventListener('input', (e) => {
      setNote(pos.word, e.target.value);
      updateWikiSuggestions(editor);
    });
    editor.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        handleSpaceAutoLink(editor, e);
      }
    });
    editor.addEventListener('keyup', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
        handleWikiSuggestionKeys(e, editor);
      } else {
        updateWikiSuggestions(editor);
      }
    });
    editor.addEventListener('click', () => updateWikiSuggestions(editor));
    editor.addEventListener('paste', (e) => handleEditorPaste(e, editor, pos.word));
  }

  startNoteTimer();
  if (state.isDiaporamaRunning) startDiaporamaProgress();
}

function formatPlainNoteText(plain) {
  const parts = plain.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s<]+)/g);
  return parts.map((part) => {
    if (!part) return '';
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) return `<strong>${linkifyPlainText(boldMatch[1])}</strong>`;
    if (/^https?:\/\//.test(part)) {
      return `<a href="#" data-url="${escapeHtml(part)}">${escapeHtml(part)}</a>`;
    }
    return linkifyPlainText(part);
  }).join('');
}

function renderRichNote(text) {
  if (!text) return '<p style="opacity:0.5;text-align:center">No content yet. Switch to edit mode ✍️</p>';

  let html = '';
  const imgPattern = /(?:data:image\/[^;\s]+;base64,[^\s]+|https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)|\/images\/[^\s]+\.(?:jpg|jpeg|png|gif|webp|svg)|blob:[^\s]+)/gi;
  const ytPattern = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;

  const plain = noteToPlain(text);

  [...plain.matchAll(imgPattern)].forEach((m) => {
    html += `<img class="note-image" src="${m[0]}" alt="Note image" loading="lazy">`;
  });

  [...plain.matchAll(ytPattern)].forEach((m) => {
    const id = m[1];
    html += `<div class="youtube-preview" data-url="${m[0]}">
      <img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" alt="YouTube">
      <div class="play">▶️</div>
    </div>`;
  });

  const textOnly = plain.replace(imgPattern, '').trim();
  html += `<div>${formatPlainNoteText(textOnly)}</div>`;
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
    openNote(idx, { newTab: true });
  } else {
    const current = state.positions[state.editingIndex];
    state.positions.push({ word: targetWord, x: current.x + 200, y: current.y + 200, level: 0 });
    ensureNoteDate(targetWord);
    touchWord(targetWord);
    touchPos(targetWord);
    save();
    openNote(state.positions.length - 1, { newTab: true });
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
      if (idx !== -1) { page.classList.add('hidden'); openNote(idx, { newTab: true }); }
    });
  });
}

// ─── All Notes Page (home) ───────────────────────────────────────────────────

function showMapView() {
  cancelAnimationFrame(allNotesScrollRAF);
  $('#page-all-notes').classList.add('hidden');
  document.body.classList.remove('home-view');
  document.body.classList.add('map-view');
  render();
}

let allNotesScrollRAF = null;

const allNotesUI = {
  searchQ: '',
  autoScroll: false,
  scrollSpeed: 1,
  built: false,
  currentFolderId: null,
  dragNoteIndex: null,
  dragMoved: false,
};

function clearAllNotesDropHighlights() {
  $$('.drop-target-active').forEach((el) => el.classList.remove('drop-target-active'));
}

// Auto-scroll the notes list while dragging near its top/bottom edge, so
// off-screen folders remain reachable during a touch drag.
let dragScrollDir = 0;
let dragScrollRAF = null;
function dragScrollStep() {
  const list = document.querySelector('#all-notes-list');
  if (!list || dragScrollDir === 0) { dragScrollRAF = null; return; }
  list.scrollTop += dragScrollDir * 12;
  dragScrollRAF = requestAnimationFrame(dragScrollStep);
}
function updateDragScroll(clientY) {
  const list = document.querySelector('#all-notes-list');
  if (!list) { dragScrollDir = 0; return; }
  const rect = list.getBoundingClientRect();
  const edge = 64;
  if (clientY < rect.top + edge) dragScrollDir = -1;
  else if (clientY > rect.bottom - edge) dragScrollDir = 1;
  else dragScrollDir = 0;
  if (dragScrollDir !== 0 && !dragScrollRAF) dragScrollRAF = requestAnimationFrame(dragScrollStep);
}
function stopDragScroll() {
  dragScrollDir = 0;
  if (dragScrollRAF) { cancelAnimationFrame(dragScrollRAF); dragScrollRAF = null; }
}

function bindAllNotesDragDrop(updateList) {
  const page = $('#page-all-notes');
  if (!page) return;

  page.querySelectorAll('.note-item[data-index]').forEach((item) => {
    item.setAttribute('draggable', 'true');

    item.addEventListener('dragstart', (e) => {
      allNotesUI.dragNoteIndex = +item.dataset.index;
      allNotesUI.dragMoved = false;
      if (allNotesUI.autoScroll) {
        allNotesUI.autoScroll = false;
        cancelAnimationFrame(allNotesScrollRAF);
        const toggle = $('#auto-scroll-toggle');
        if (toggle) toggle.textContent = '▶️';
      }
      item.classList.add('dragging');
      e.dataTransfer.setData('application/x-mindmap-note', item.dataset.index);
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      clearAllNotesDropHighlights();
      setTimeout(() => { allNotesUI.dragNoteIndex = null; }, 50);
    });

    item.addEventListener('click', (e) => {
      if (allNotesUI.dragMoved) {
        allNotesUI.dragMoved = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      openNote(+item.dataset.index, { newTab: true });
    });

    let pressTimer = null;
    let pointerStart = null;

    item.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointerStart = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        allNotesUI.dragNoteIndex = +item.dataset.index;
        allNotesUI.dragMoved = false;
        item.classList.add('dragging');
        try { item.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }, 350);
    });

    item.addEventListener('pointermove', (e) => {
      if (pressTimer && pointerStart) {
        if (Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 10) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      }
      if (!item.classList.contains('dragging')) return;
      if (allNotesUI.dragNoteIndex !== +item.dataset.index) return;
      allNotesUI.dragMoved = true;
      const point = e.touches?.[0] || e;
      updateDragScroll(point.clientY);
      const target = document.elementFromPoint(point.clientX, point.clientY);
      clearAllNotesDropHighlights();
      target?.closest('.folder-item[data-folder-id], .drop-root-zone')
        ?.classList.add('drop-target-active');
    });

    // While an active touch drag is in progress, stop the browser from
    // treating the vertical move as a scroll (which would fire pointercancel
    // and drop the note on the wrong target or nowhere).
    item.addEventListener('touchmove', (e) => {
      if (item.classList.contains('dragging')) e.preventDefault();
    }, { passive: false });

    const endPointer = (e) => {
      clearTimeout(pressTimer);
      pressTimer = null;
      stopDragScroll();
      if (!item.classList.contains('dragging') || allNotesUI.dragNoteIndex !== +item.dataset.index) {
        pointerStart = null;
        return;
      }
      const point = e.changedTouches?.[0] || e;
      const target = document.elementFromPoint(point.clientX, point.clientY);
      const folderEl = target?.closest('.folder-item[data-folder-id]');
      const rootEl = target?.closest('.drop-root-zone');
      const word = state.positions[allNotesUI.dragNoteIndex]?.word;
      if (word) {
        if (folderEl) setNoteFolder(word, folderEl.dataset.folderId);
        else if (rootEl) setNoteFolder(word, null);
        if (folderEl || rootEl) updateList();
      }
      item.classList.remove('dragging');
      clearAllNotesDropHighlights();
      try { item.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      allNotesUI.dragNoteIndex = null;
      pointerStart = null;
    };

    item.addEventListener('pointerup', endPointer);
    item.addEventListener('pointercancel', endPointer);
  });

  page.querySelectorAll('.folder-item[data-folder-id], .drop-root-zone').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearAllNotesDropHighlights();
      zone.classList.add('drop-target-active');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-target-active');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drop-target-active');
      const idx = allNotesUI.dragNoteIndex ?? +e.dataTransfer.getData('application/x-mindmap-note');
      const word = state.positions[idx]?.word;
      if (!word) return;
      allNotesUI.dragMoved = true;
      if (zone.classList.contains('drop-root-zone')) setNoteFolder(word, null);
      else setNoteFolder(word, zone.dataset.folderId);
      updateList();
    });
  });
}

function openAllNotesPage() {
  const page = $('#page-all-notes');
  document.body.classList.add('home-view');
  document.body.classList.remove('map-view');

  function getVisibleFolders() {
    const q = allNotesUI.searchQ.toLowerCase();
    return state.folders
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getSorted() {
    const q = allNotesUI.searchQ.toLowerCase();
    return state.positions
      .map((p, i) => ({ ...p, index: i }))
      .filter((p) => p.word.toLowerCase().includes(q))
      .filter((p) => {
        if (q) return true;
        const folderId = getNoteFolderId(p.word);
        if (allNotesUI.currentFolderId) {
          return folderId === allNotesUI.currentFolderId;
        }
        return !folderId;
      })
      .sort((a, b) => a.word.localeCompare(b.word));
  }

  function updateBreadcrumb() {
    const el = $('#all-notes-breadcrumb');
    const title = $('#all-notes-title');
    if (!el || !title) return;

    const folderTab = isDedicatedFolderTab();
    const folder = allNotesUI.currentFolderId ? getFolderById(allNotesUI.currentFolderId) : null;
    if (folder || (folderTab && allNotesUI.currentFolderId)) {
      const name = folder ? folder.name : 'Dossier';
      title.textContent = name;
      el.classList.remove('hidden');
      const closeBtn = folderTab
        ? `<button type="button" class="btn-icon btn-folder-close" id="btn-folder-close" title="Fermer">❌</button>`
        : `<button type="button" class="btn-icon" id="btn-folder-back" title="Retour">←</button>`;
      el.innerHTML = `
        ${closeBtn}
        <span class="drop-root-zone drop-root-label">📁 ${escapeHtml(name)} — glisser ici pour retirer</span>
      `;
      if (folderTab) {
        $('#btn-folder-close')?.addEventListener('click', () => closeFolder());
      } else {
        $('#btn-folder-back')?.addEventListener('click', () => {
          allNotesUI.currentFolderId = null;
          updateBreadcrumb();
          updateList();
        });
      }
    } else {
      title.textContent = 'All Notes';
      el.classList.add('hidden');
      el.innerHTML = '';
    }
  }

  function bindListItems() {
    page.querySelectorAll('.list-item[data-index]').forEach((item) => {
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showNoteListActions(+item.dataset.index);
      });
    });
    page.querySelectorAll('.list-item[data-folder-id]').forEach((item) => {
      item.addEventListener('click', () => {
        openFolderInNewTab(item.dataset.folderId);
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showFolderActions(item.dataset.folderId);
      });
    });
  }

  function updateList() {
    const sorted = getSorted();
    const folders = allNotesUI.currentFolderId && !allNotesUI.searchQ ? [] : getVisibleFolders();
    const exactMatch = sorted.some(
      (p) => p.word.toLowerCase() === allNotesUI.searchQ.trim().toLowerCase(),
    );
    const createBtn = $('#create-from-search');

    if (allNotesUI.searchQ.trim() && !exactMatch) {
      if (!createBtn) {
        const el = document.createElement('div');
        el.id = 'create-from-search';
        el.className = 'list-item create';
        el.style.cssText = 'color:var(--accent);font-weight:600;text-align:center';
        el.addEventListener('click', async () => {
          const word = allNotesUI.searchQ.trim();
          if (!word) return;
          addWord(word, -state.offsetX, -state.offsetY);
          if (allNotesUI.currentFolderId) {
            setNoteFolder(word, allNotesUI.currentFolderId);
          }
          if (Sync.isServerMode()) {
            try {
              await Sync.pushData(getSyncPayload());
            } catch (e) {
              console.error('Sync before new tab:', e);
            }
          }
          const idx = state.positions.findIndex(
            (p) => p.word.toLowerCase() === word.toLowerCase(),
          );
          if (idx !== -1) openNote(idx, { newTab: true, edit: true });
          allNotesUI.searchQ = '';
          const searchInput = $('#all-notes-search');
          if (searchInput) searchInput.value = '';
          updateList();
        });
        $('#all-notes-list').before(el);
      }
      createBtn.textContent = `✨ Create "${allNotesUI.searchQ}"`;
    } else {
      createBtn?.remove();
    }

    const list = $('#all-notes-list');
    if (list) {
      const folderHtml = folders.map((f) => {
        const count = countNotesInFolder(f.id);
        return `
          <div class="list-item folder-item" data-folder-id="${escapeHtml(f.id)}">
            <span class="folder-name">📁 ${escapeHtml(f.name)}</span>
            <span class="folder-meta">${count} note${count !== 1 ? 's' : ''}</span>
          </div>
        `;
      }).join('');

      const notesHtml = sorted.map((p) => `
        <div class="list-item note-item" data-index="${p.index}" draggable="true">
          <div style="font-weight:600">📝 ${escapeHtml(p.word)}</div>
        </div>
      `).join('');

      list.innerHTML = folderHtml + notesHtml;
      bindListItems();
      bindAllNotesDragDrop(updateList);
    }
  }

  function buildShell() {
    page.innerHTML = `
      <div class="all-notes-layout">
        <div class="page-header page-header-centered">
          <button type="button" class="btn-icon header-side" id="btn-show-map" title="Mind Map">🗺️</button>
          <h1 id="all-notes-title">All Notes</h1>
          <button type="button" class="btn-icon header-side" id="btn-new-folder" title="Nouveau dossier">📁</button>
        </div>
        <div id="all-notes-breadcrumb" class="all-notes-breadcrumb hidden"></div>
        <input type="text" id="all-notes-search" class="all-notes-search" placeholder="Search in all notes..." value="">
        <div class="page-list" id="all-notes-list" style="overflow-y:auto"></div>
        <div class="auto-scroll-bar">
          <button class="btn-icon" id="auto-scroll-toggle">▶️</button>
          <span>Auto-Scroll</span>
          <input type="range" id="scroll-speed" min="0.5" max="30" step="0.5" value="${allNotesUI.scrollSpeed}">
          <span id="speed-label">${allNotesUI.scrollSpeed}x</span>
        </div>
      </div>
    `;

    const searchInput = $('#all-notes-search');
    searchInput.value = allNotesUI.searchQ;
    searchInput.addEventListener('input', (e) => {
      allNotesUI.searchQ = e.target.value;
      updateList();
    });

    $('#btn-show-map').addEventListener('click', showMapView);
    $('#btn-new-folder').addEventListener('click', () => {
      showModal('Nouveau dossier', `<input type="text" id="folder-name-input" placeholder="Nom du dossier">`, [
        { label: 'Annuler', action: 'close' },
        { label: 'Créer', action: 'ok', class: 'btn-primary', onClick: () => {
          const name = $('#folder-name-input').value.trim();
          if (name) {
            createFolder(name);
            hideModal();
            updateList();
          }
        }},
      ]);
      setTimeout(() => $('#folder-name-input')?.focus(), 50);
    });
    $('#auto-scroll-toggle').addEventListener('click', () => {
      allNotesUI.autoScroll = !allNotesUI.autoScroll;
      $('#auto-scroll-toggle').textContent = allNotesUI.autoScroll ? '⏸️' : '▶️';
      if (allNotesUI.autoScroll) doAutoScroll();
      else cancelAnimationFrame(allNotesScrollRAF);
    });
    $('#scroll-speed').addEventListener('input', (e) => {
      allNotesUI.scrollSpeed = +e.target.value;
      $('#speed-label').textContent = allNotesUI.scrollSpeed + 'x';
    });

    allNotesUI.built = true;
  }

  function doAutoScroll() {
    const list = $('#all-notes-list');
    if (list && allNotesUI.autoScroll) {
      list.scrollTop += allNotesUI.scrollSpeed;
      allNotesScrollRAF = requestAnimationFrame(doAutoScroll);
    }
  }

  if (!allNotesUI.built || !page.querySelector('.all-notes-layout')) {
    buildShell();
  } else {
    $('#all-notes-search').value = allNotesUI.searchQ;
    $('#auto-scroll-toggle').textContent = allNotesUI.autoScroll ? '⏸️' : '▶️';
  }

  updateBreadcrumb();
  updateList();
  page.classList.remove('hidden');
}

function showFolderActions(folderId) {
  const folder = getFolderById(folderId);
  if (!folder) return;

  showModal(`Dossier « ${escapeHtml(folder.name)} »`, `
    <div class="modal-actions">
      <button class="btn btn-block btn-primary" id="rename-folder">✏️ Renommer</button>
      <button class="btn btn-block btn-danger" id="delete-folder">🗑️ Supprimer le dossier</button>
    </div>
  `, [{ label: 'Annuler', action: 'close' }]);

  $('#rename-folder').addEventListener('click', () => {
    hideModal();
    showModal('Renommer le dossier', `<input type="text" id="rename-folder-input" value="${escapeHtml(folder.name)}">`, [
      { label: 'Annuler', action: 'close' },
      { label: 'OK', action: 'ok', class: 'btn-primary', onClick: () => {
        const name = $('#rename-folder-input').value.trim();
        if (name) renameFolder(folderId, name);
        hideModal();
        openAllNotesPage();
      }},
    ]);
  });

  $('#delete-folder').addEventListener('click', () => {
    if (allNotesUI.currentFolderId === folderId) {
      allNotesUI.currentFolderId = null;
    }
    deleteFolder(folderId);
    hideModal();
    openAllNotesPage();
  });
}

function showMoveNoteToFolderModal(word) {
  const currentFolderId = getNoteFolderId(word);
  const folderOptions = state.folders
    .filter((f) => f.id !== currentFolderId)
    .map((f) => `
      <button type="button" class="btn btn-block folder-move-btn" data-folder-id="${escapeHtml(f.id)}">
        📁 ${escapeHtml(f.name)}
      </button>
    `).join('');

  showModal(`Déplacer « ${escapeHtml(word)} »`, `
    <div class="modal-actions">
      ${folderOptions || '<p style="opacity:0.6;text-align:center">Aucun autre dossier</p>'}
      ${currentFolderId ? '<button type="button" class="btn btn-block" id="remove-from-folder">↩ Retirer du dossier</button>' : ''}
    </div>
  `, [{ label: 'Annuler', action: 'close' }]);

  $$('.folder-move-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setNoteFolder(word, btn.dataset.folderId);
      hideModal();
      openAllNotesPage();
    });
  });
  $('#remove-from-folder')?.addEventListener('click', () => {
    setNoteFolder(word, null);
    hideModal();
    openAllNotesPage();
  });
}

function showNoteListActions(index) {
  const pos = state.positions[index];
  showModal(`Actions for "${escapeHtml(pos.word)}"`, `
    <div class="modal-actions">
      <button class="btn btn-block btn-primary" id="move-note-folder">📁 Déplacer vers un dossier</button>
      <button class="btn btn-block btn-primary" id="rename-note">✏️ Rename</button>
      <button class="btn btn-block btn-danger" id="delete-note">🗑️ Delete Note</button>
    </div>
  `, [{ label: 'Cancel', action: 'close' }]);

  $('#move-note-folder').addEventListener('click', () => {
    hideModal();
    showMoveNoteToFolderModal(pos.word);
  });

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
          renameNoteDate(pos.word, newName);
          renameNoteFolderKey(pos.word, newName);
          touchWord(newName);
          touchPos(newName);
          recordDeletion(pos.word);
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
      setNote(word, data.note, { immediate: true });
      try {
        await Sync.pushData(getSyncPayload());
      } catch (syncErr) {
        console.error('Sync after AI:', syncErr);
        showToast('Note générée — sync en attente');
      }
      const parts = [];
      if (data.imageModel) parts.push(data.imageModel);
      if (data.warnings?.length) parts.push(`${data.warnings.length} avertissement`);
      const msg = parts.length
        ? `Note générée (${parts.join(', ')})`
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

async function syncBeforeClose() {
  if (!Sync.isServerMode()) {
    save();
    return;
  }
  const serverData = await Sync.fetchData();
  mergeRemoteState(getLocalStoredData(), serverData, { preferLocal: true });
  persistLocal(new Date().toISOString());
  await Sync.pushData(getSyncPayload());
}

async function closeNote() {
  state.editingIndex = -1;
  clearInterval(timerInterval);

  document.body.classList.remove('note-view');
  $('#page-note').classList.add('hidden');
  document.title = DEFAULT_TITLE;

  const dedicatedTab = isDedicatedNoteTab();
  const syncPromise = syncBeforeClose().catch((e) => {
    console.error('Save before close:', e);
    if (Sync.isServerMode()) Sync.flushSync(getSyncPayload);
  });

  if (dedicatedTab) {
    returnToAllNotes();
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.focus();
      }
    } catch (_) { /* ignore */ }
    window.close();
    setTimeout(() => {
      if (document.hidden) return;
      history.replaceState({ view: 'all-notes' }, '', location.pathname);
    }, 150);
    await syncPromise;
    return;
  }

  returnToAllNotes();
  await syncPromise;
}

async function uploadImageDataUri(dataUri) {
  if (!Sync.isServerMode()) return dataUri;
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: Sync.headers,
    body: JSON.stringify({ data: dataUri }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload image échoué');
  return data.url;
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const caret = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  textarea.focus();
}

// Colle une image du presse-papier en mode édition : upload + insertion de l'URL.
async function handleEditorPaste(e, editor, word) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItem = Array.from(items).find((it) => it.type && it.type.startsWith('image/'));
  if (!imageItem) return; // pas d'image : laisser le collage de texte normal

  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;

  showToast("Ajout de l'image…");
  const reader = new FileReader();
  reader.onload = async (ev) => {
    let ref = ev.target.result;
    try {
      ref = await uploadImageDataUri(ev.target.result);
    } catch (err) {
      console.error('Paste image upload failed, storing inline:', err);
      showToast('Image collée (hors ligne)');
    }
    const caret = editor.selectionStart ?? editor.value.length;
    const before = editor.value.slice(0, caret);
    const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    insertTextAtCursor(editor, `${prefix}${ref}\n`);
    setNote(word, editor.value, { immediate: true });
    updateWikiSuggestions(editor);
    showToast('Image ajoutée');
  };
  reader.readAsDataURL(file);
}

function pickImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const word = state.positions[state.editingIndex].word;
      let ref = ev.target.result;
      try {
        ref = await uploadImageDataUri(ev.target.result);
      } catch (err) {
        console.error('Image upload failed, storing inline:', err);
        showToast('Image ajoutée (hors ligne)');
      }
      const current = getNote(word);
      setNote(word, current ? `${current}\n${ref}` : ref, { immediate: true });
      renderNoteView();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function migrateInlineImages() {
  if (!Sync.isServerMode()) return;
  const dataUriPattern = /data:image\/[^;\s]+;base64,[^\s]+/g;
  let changed = false;

  for (const key of Object.keys(state.notes)) {
    const content = state.notes[key];
    if (!content || !content.includes('data:image/')) continue;
    const matches = content.match(dataUriPattern);
    if (!matches) continue;

    let updated = content;
    for (const dataUri of matches) {
      try {
        const url = await uploadImageDataUri(dataUri);
        updated = updated.split(dataUri).join(url);
      } catch (err) {
        console.error('Migration image échouée pour', key, err);
      }
    }
    if (updated !== content) {
      state.notes[key] = updated;
      changed = true;
    }
  }

  if (changed) {
    persistLocal(new Date().toISOString());
    Sync.scheduleSync(getSyncPayload, true);
    if (state.editingIndex !== -1) renderNoteView();
    console.log('Migration des images terminée');
  }
}

function getAllMindmapWords() {
  return [...new Set(state.positions.map((p) => p.word))];
}

function getWordBeforeCursor(text, cursor) {
  const before = text.substring(0, cursor);
  const match = before.match(/(?:^|[\s\n])([^\s\[\]]+)$/);
  if (!match || !match[1]) return null;
  return {
    word: match[1],
    start: cursor - match[1].length,
    end: cursor,
  };
}

function wordExistsInMap(word) {
  return state.positions.some((p) => p.word.toLowerCase() === word.toLowerCase());
}

function getCanonicalWord(word) {
  const found = state.positions.find((p) => p.word.toLowerCase() === word.toLowerCase());
  return found ? found.word : word;
}

function handleSpaceAutoLink(editor, e) {
  const cursor = editor.selectionStart;
  const text = editor.value;
  const info = getWordBeforeCursor(text, cursor);
  if (!info || info.word.length < 1) return false;
  if (!/[a-zA-ZÀ-ÿ]/.test(info.word)) return false;
  if (/^https?:\/\//i.test(info.word)) return false;

  const canonical = getCanonicalWord(info.word);

  if (!wordExistsInMap(info.word)) {
    const anchor = state.positions[state.editingIndex];
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 80;
    const x = anchor ? anchor.x + Math.cos(angle) * dist : 0;
    const y = anchor ? anchor.y + Math.sin(angle) * dist : 0;
    addWord(canonical, x, y);
  }

  e.preventDefault();
  const replacement = `${canonical} `;
  const newText = text.substring(0, info.start) + replacement + text.substring(info.end);
  editor.value = newText;
  editor.selectionStart = editor.selectionEnd = info.start + replacement.length;

  const noteWord = state.positions[state.editingIndex]?.word;
  if (noteWord) setNote(noteWord, newText);
  $('#wiki-suggestions')?.classList.add('hidden');
  return true;
}

function getWikiAutocompleteContext(text, cursor) {
  const wordInfo = getWordBeforeCursor(text, cursor);
  if (wordInfo && wordInfo.word.length >= 1) {
    return {
      mode: 'word',
      query: wordInfo.word,
      replaceStart: wordInfo.start,
      replaceEnd: wordInfo.end,
    };
  }

  return null;
}

function filterWikiSuggestions(query) {
  const q = query.toLowerCase();
  return getAllMindmapWords()
    .filter((w) => w.toLowerCase().includes(q))
    .sort((a, b) => {
      const aLow = a.toLowerCase();
      const bLow = b.toLowerCase();
      const aStarts = aLow.startsWith(q);
      const bStarts = bLow.startsWith(q);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, 8);
}

let wikiSuggestionIndex = 0;

function updateWikiSuggestions(editor) {
  const box = $('#wiki-suggestions');
  if (!editor || !box) return;

  const ctx = getWikiAutocompleteContext(editor.value, editor.selectionStart);
  if (!ctx || !ctx.query) {
    box.classList.add('hidden');
    box.innerHTML = '';
    wikiSuggestionIndex = 0;
    return;
  }

  const matches = filterWikiSuggestions(ctx.query);
  if (!matches.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    wikiSuggestionIndex = 0;
    return;
  }

  wikiSuggestionIndex = Math.min(wikiSuggestionIndex, matches.length - 1);
  box.classList.remove('hidden');
  box.innerHTML = matches.map((word, i) => `
    <button type="button" class="wiki-suggestion-item${i === wikiSuggestionIndex ? ' active' : ''}" data-word="${escapeHtml(word)}">
      🔗 ${escapeHtml(word)}
    </button>
  `).join('');

  box.querySelectorAll('.wiki-suggestion-item').forEach((btn, i) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyWikiSuggestion(editor, btn.dataset.word);
    });
    btn.addEventListener('mouseenter', () => {
      wikiSuggestionIndex = i;
      box.querySelectorAll('.wiki-suggestion-item').forEach((el, j) => {
        el.classList.toggle('active', j === i);
      });
    });
  });
}

function applyWikiSuggestion(editor, word) {
  const ctx = getWikiAutocompleteContext(editor.value, editor.selectionStart);
  if (!ctx || !word) return;

  const text = editor.value;
  const replacement = word;
  const newText = text.substring(0, ctx.replaceStart) + replacement + text.substring(ctx.replaceEnd);
  const newCursor = ctx.replaceStart + replacement.length;

  editor.value = newText;
  editor.selectionStart = editor.selectionEnd = newCursor;
  const noteWord = state.positions[state.editingIndex]?.word;
  if (noteWord) setNote(noteWord, newText);
  $('#wiki-suggestions')?.classList.add('hidden');
  editor.focus();
}

function handleWikiSuggestionKeys(e, editor) {
  const box = $('#wiki-suggestions');
  if (!box || box.classList.contains('hidden')) return;

  const items = [...box.querySelectorAll('.wiki-suggestion-item')];
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    wikiSuggestionIndex = (wikiSuggestionIndex + 1) % items.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    wikiSuggestionIndex = (wikiSuggestionIndex - 1 + items.length) % items.length;
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const word = items[wikiSuggestionIndex]?.dataset.word;
    if (word) applyWikiSuggestion(editor, word);
    return;
  } else if (e.key === 'Escape') {
    box.classList.add('hidden');
    return;
  } else {
    return;
  }

  items.forEach((el, i) => el.classList.toggle('active', i === wikiSuggestionIndex));
}

function insertWikilink() {
  const editor = $('#note-editor');
  if (!editor) return;
  updateWikiSuggestions(editor);
  editor.focus();
}

// ─── Public API ──────────────────────────────────────────────────────────────

window.App = {
  closeNote,
  closeFolder,
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
      <button class="btn btn-primary btn-block" id="btn-cloud-backup" style="margin-bottom:8px">📥 Télécharger ma sauvegarde complète (textes + images)</button>
      <button class="btn btn-secondary btn-block" id="btn-cloud-restore" style="margin-bottom:8px">📂 Restaurer depuis un fichier</button>
      <p style="opacity:0.6;font-size:13px;margin-bottom:16px">💡 Conservez ce fichier ailleurs (Drive, email, disque dur) pour une permanence garantie.</p>
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
      showToast('Préparation de la sauvegarde…');
      try {
        const res = await fetch('/api/data/full-backup', { headers: Sync.headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mindmap-full-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        const imgCount = Object.keys(data.images || {}).length;
        showToast(`Sauvegarde téléchargée (${imgCount} image${imgCount !== 1 ? 's' : ''})`);
      } catch (e) {
        showToast('Erreur: ' + e.message);
      }
    });
    $('#btn-cloud-restore').addEventListener('click', () => $('#restore-file').click());
    $('#restore-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      showToast('Restauration en cours…');
      try {
        const data = JSON.parse(await file.text());
        const res = await fetch('/api/data/full-restore', {
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
        const imgMsg = result.restoredImages ? `, ${result.restoredImages} image(s)` : '';
        showToast(`Sauvegarde restaurée${imgMsg} ✓`);
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

function getLocalStoredData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getLocalTimestamp(data) {
  if (!data) return 0;
  const ts = data._updatedAt || data.updated_at;
  return ts ? Date.parse(ts) : 0;
}

function applyRemoteData(data) {
  const localStored = getLocalStoredData();
  applyData(data);
  mergeRemoteState(localStored, data);
  // Conserver l'horodatage serveur pour ne pas fausser la comparaison au rechargement
  persistLocal(data.updated_at || new Date().toISOString());
  Sync.rememberServerData({
    ...data,
    positions: state.positions,
    notes: state.notes,
    history: state.history,
    settings: getSyncPayload().settings,
  });
  if (remoteDataWasEnriched(localStored, data)) {
    Sync.lastPayload = getSyncPayload();
    Sync.scheduleSync(getSyncPayload, true);
  }
}

function handleRemoteUpdate(data) {
  if (state.isAiGenerating) return;

  if (state.editingIndex !== -1) {
    const localStored = getLocalStoredData();
    const protectedKeys = getProtectedNoteKeys();
    const localSide = getSyncPayload().settings;
    const serverSide = data.settings || {};
    state.notes = mergeNotesByTime(
      { ...(localStored?.notes || {}), ...state.notes },
      data.notes,
      localSide.wordTimes, serverSide.wordTimes,
      protectedKeys, 'server',
    );
    state.positions = mergePositionsByTime(
      state.positions, data.positions,
      localSide.posTimes, serverSide.posTimes, 'server',
    );
    applyMergedSettings(localSide, serverSide);
    applyTombstones();
    persistLocal(data.updated_at || new Date().toISOString());
    Sync.rememberServerData({
      ...data,
      positions: state.positions,
      notes: state.notes,
      history: state.history,
      settings: getSyncPayload().settings,
    });
    if (remoteDataWasEnriched(localStored, data)) {
      Sync.scheduleSync(getSyncPayload, true);
    }
    return;
  }

  applyRemoteData(data);
  render();
  if (document.body.classList.contains('home-view')) {
    openAllNotesPage();
  }
}

async function loadFromServer() {
  let serverData = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      serverData = await Sync.fetchData();
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }

  const serverTime = serverData.updated_at ? Date.parse(serverData.updated_at) : 0;
  const localData = getLocalStoredData();
  const localTime = getLocalTimestamp(localData);
  const localHasData =
    (localData?.positions?.length > 0) || (Object.keys(localData?.notes || {}).length > 0);

  if (serverTime > 0 && localTime > serverTime) {
    applyData(localData);
    mergeRemoteState(localData, serverData, { preferLocal: true });
    await Sync.pushData(getSyncPayload());
    const pushedAt = new Date().toISOString();
    persistLocal(pushedAt);
    Sync.setServerTimestamp(pushedAt);
    return;
  }

  if (serverTime > 0) {
    const localStored = getLocalStoredData();
    applyData(serverData);
    mergeRemoteState(localStored, serverData);
    persistLocal(serverData.updated_at || new Date().toISOString());
    Sync.rememberServerData({
      ...serverData,
      positions: state.positions,
      notes: state.notes,
      history: state.history,
      settings: getSyncPayload().settings,
    });
    if (remoteDataWasEnriched(localStored, serverData)) {
      await Sync.pushData(getSyncPayload());
    }
    return;
  }

  if (localHasData) {
    applyData(localData);
    await Sync.pushData(getSyncPayload());
    persistLocal(new Date().toISOString());
    return;
  }

  initDefaultData();
}

function startApp() {
  document.body.classList.toggle('light', !state.isDark);
  document.body.classList.toggle('dark', state.isDark);
  $('#btn-theme').textContent = state.isDark ? '☀️' : '🌙';
  resizeCanvas();
  render();
}

async function syncInBackground() {
  try {
    Sync.setStatus('syncing', '☁️ Sync…');
    await loadFromServer();
    startApp();
    if (state.editingIndex !== -1) renderNoteView();
    else render();
    if (document.body.classList.contains('home-view')) openAllNotesPage();
    Sync.setStatus('synced', '☁️ Sync ✓');
    setTimeout(() => Sync.setStatus('hidden'), 2000);
    migrateInlineImages().catch((e) => console.error('Migration images:', e));
  } catch (e) {
    console.error('Background sync failed:', e);
    Sync.setStatus('error', '☁️ Mode hors ligne');
    setTimeout(() => Sync.setStatus('hidden'), 3000);
  }
}

async function bootstrap() {
  const params = new URLSearchParams(location.search);
  const isNoteTab = params.has('note');
  const isFolderTab = params.has('folder');
  if (isNoteTab) showNoteLoadingShell();
  if (isFolderTab) document.body.classList.add('folder-tab');

  load();
  startApp();

  if (Sync.isServerMode()) {
    Sync.initLifecycle(getSyncPayload, handleRemoteUpdate, {
      getProtectedNoteKeys,
      onPushSuccess: (payload) => {
        clearDirtyNoteKeys(payload?.notes);
        if (payload) Sync.rememberServerData(payload);
      },
    });
    Sync.startPolling(handleRemoteUpdate);
    Sync.startPeriodicSave(getSyncPayload);
    syncInBackground();
  }

  if (!openNoteFromUrl() && !openFolderFromUrl()) {
    openAllNotesPage();
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────────

bootstrap();
window.addEventListener('resize', resizeCanvas);

// Keyboard shortcut: Escape closes overlays
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#image-lightbox')?.classList.contains('hidden')) closeImageLightbox();
    else if (!$('#modal-overlay').classList.contains('hidden')) hideModal();
    else if (state.editingIndex !== -1) closeNote();
    else if (isDedicatedFolderTab()) closeFolder();
    else {
      $$('.page-overlay').forEach(p => p.classList.add('hidden'));
    }
  }
});
