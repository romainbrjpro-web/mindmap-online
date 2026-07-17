const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DEFAULT_USER_ID = 1;
const MAX_BACKUPS = 10;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'store.json');
const backupDir = path.join(dataDir, 'backups');
const imagesDir = path.join(dataDir, 'images');

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function saveImageDataUri(dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUri || '');
  if (!match) throw new Error('Image invalide');
  const mime = match[1].toLowerCase();
  const ext = MIME_EXT[mime] || 'png';
  const buffer = Buffer.from(match[2], 'base64');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(imagesDir, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }
  return `/images/${filename}`;
}

function imageFilePath(urlPath) {
  return path.join(imagesDir, path.basename(urlPath));
}

function readImageDataUri(urlPath) {
  const filePath = imageFilePath(urlPath);
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = Object.keys(MIME_EXT).find((m) => MIME_EXT[m] === ext) || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function writeImageFromDataUri(urlPath, dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUri || '');
  if (!match) return false;
  fs.writeFileSync(imageFilePath(urlPath), Buffer.from(match[2], 'base64'));
  return true;
}

let lastBackupAt = 0;
let dataLock = Promise.resolve();
let storeCache = null;

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function withDataLock(fn) {
  const run = dataLock.then(() => fn());
  dataLock = run.catch(() => {});
  return run;
}

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
}

function listBackups() {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort().reverse();
}

function getBackupInfo(file) {
  try {
    const filePath = path.join(backupDir, file);
    const store = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const data = store.mindmap_data?.[DEFAULT_USER_ID];
    if (!data) return null;
    const positions = JSON.parse(data.positions || '[]');
    const notes = JSON.parse(data.notes || '{}');
    return {
      filename: file,
      wordCount: positions.length,
      noteCount: Object.keys(notes).length,
      updated_at: data.updated_at || null,
      sizeBytes: fs.statSync(filePath).size,
    };
  } catch {
    return null;
  }
}

function listBackupSnapshots() {
  return listBackups()
    .map(getBackupInfo)
    .filter(Boolean);
}

function restoreFromBackup(filename) {
  const safe = path.basename(filename);
  if (!safe.endsWith('.json')) throw new Error('Fichier invalide');
  const filePath = path.join(backupDir, safe);
  if (!fs.existsSync(filePath)) throw new Error('Sauvegarde introuvable');
  const store = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  storeCache = store;
  fs.writeFileSync(dbFile, JSON.stringify(store));
  return store;
}

function autoRecoverIfEmpty() {
  const row = stmts.getData(DEFAULT_USER_ID);
  if (!row) return false;
  const positions = JSON.parse(row.positions || '[]');
  const notes = JSON.parse(row.notes || '{}');
  const isEmpty = positions.length === 0 && Object.keys(notes).length === 0;
  if (!isEmpty) return false;

  for (const file of listBackups()) {
    const info = getBackupInfo(file);
    if (info && (info.wordCount > 0 || info.noteCount > 0)) {
      restoreFromBackup(file);
      console.log(`🔄 Auto-récupération : ${file} (${info.wordCount} mots, ${info.noteCount} notes)`);
      return true;
    }
  }
  return false;
}

function loadStore(force = false) {
  if (!force && storeCache) return storeCache;
  if (!fs.existsSync(dbFile)) {
    storeCache = { users: [], mindmap_data: {} };
    return storeCache;
  }
  try {
    storeCache = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    return storeCache;
  } catch (e) {
    console.error('Erreur lecture store.json, tentative backup…', e.message);
    for (const file of listBackups()) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));
        fs.writeFileSync(dbFile, JSON.stringify(data));
        storeCache = data;
        console.log(`✅ Données restaurées depuis ${file}`);
        return data;
      } catch { /* try next */ }
    }
    storeCache = { users: [], mindmap_data: {} };
    return storeCache;
  }
}

function createBackup(store, force = false) {
  try {
    const now = Date.now();
    if (!force && now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
    lastBackupAt = now;
    const name = `store-${now}.json`;
    fs.writeFileSync(path.join(backupDir, name), JSON.stringify(store, null, 2));
    listBackups().slice(MAX_BACKUPS).forEach((f) => {
      try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* ignore */ }
    });
  } catch (e) {
    console.warn('Backup échoué:', e.message);
  }
}

function saveStore(store) {
  storeCache = store;
  const json = JSON.stringify(store);
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, dbFile);
  createBackup(store);
}

function ensureDefaultUser() {
  const store = loadStore();
  if (!store.users.length) {
    store.users.push({
      id: DEFAULT_USER_ID,
      email: 'default@mindmap.local',
      password_hash: '',
      created_at: new Date().toISOString(),
    });
    store.mindmap_data[DEFAULT_USER_ID] = {
      positions: '[]',
      notes: '{}',
      history: '[]',
      settings: '{}',
      updated_at: new Date().toISOString(),
    };
    saveStore(store);
  }
  return DEFAULT_USER_ID;
}

function init() {
  ensureDirs();
  loadStore(true);
  ensureDefaultUser();
  autoRecoverIfEmpty();
  console.log(`📁 Données stockées dans : ${dataDir}`);
}

function getStorageInfo() {
  const stats = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  const row = stmts.getData(DEFAULT_USER_ID);
  let noteCount = 0;
  let wordCount = 0;
  if (row) {
    try {
      noteCount = (row.notes.match(/"[^"]+"\s*:/g) || []).length;
      wordCount = (row.positions.match(/"word"\s*:/g) || []).length;
    } catch { /* ignore */ }
  }
  const hasDisk = process.env.RENDER_DISK === 'true';
  return {
    mode: 'json-file',
    persistent: hasDisk,
    diskConfigured: hasDisk,
    dataDir,
    noteCount,
    wordCount,
    backupCount: listBackups().length,
    sizeBytes: stats?.size || 0,
    updated_at: row?.updated_at || null,
    warning: hasDisk ? null : 'Plan gratuit ou disque non monté — risque de perte de données',
  };
}

function getDataVersion(userId = DEFAULT_USER_ID) {
  const row = stmts.getData(userId);
  return row?.updated_at || null;
}

const stmts = {
  createUser(email, passwordHash) {
    const store = loadStore();
    const user = {
      id: store.users.length ? Math.max(...store.users.map((u) => u.id)) + 1 : 1,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
    };
    store.users.push(user);
    store.mindmap_data[user.id] = {
      positions: '[]',
      notes: '{}',
      history: '[]',
      settings: '{}',
      updated_at: new Date().toISOString(),
    };
    saveStore(store);
    return { lastInsertRowid: user.id };
  },

  findUserByEmail(email) {
    const store = loadStore();
    return store.users.find((u) => u.email === email.toLowerCase()) || null;
  },

  findUserById(id) {
    const store = loadStore();
    const user = store.users.find((u) => u.id === id);
    if (!user) return null;
    return { id: user.id, email: user.email, created_at: user.created_at };
  },

  getData(userId) {
    const store = loadStore();
    return store.mindmap_data[userId] || null;
  },

  mergeNotesKeepLonger(...sources) {
    const merged = {};
    sources.forEach((notes) => {
      let parsed = notes;
      if (typeof notes === 'string') {
        try { parsed = JSON.parse(notes); } catch { parsed = {}; }
      }
      Object.entries(parsed || {}).forEach(([key, content]) => {
        const existing = merged[key] || '';
        if ((content?.length || 0) > (existing?.length || 0)) {
          merged[key] = content;
        }
      });
    });
    return merged;
  },

  mergeNotesOnSave(existingNotes, incomingNotes) {
    const existing = safeJsonParse(existingNotes, {});
    const incoming = safeJsonParse(incomingNotes, {});
    const merged = { ...existing };
    Object.entries(incoming).forEach(([key, content]) => {
      const prev = merged[key] || '';
      if (content && content.length > 0) {
        merged[key] = content;
      } else if (!prev) {
        merged[key] = content;
      }
    });
    return merged;
  },

  mergePositions(...sources) {
    const byKey = new Map();
    sources.forEach((positions) => {
      let parsed = positions;
      if (typeof positions === 'string') {
        try { parsed = JSON.parse(positions); } catch { parsed = []; }
      }
      (parsed || []).forEach((pos) => {
        if (!pos?.word) return;
        const key = pos.word.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, pos);
      });
    });
    return Array.from(byKey.values());
  },

  // Fusion LWW du contenu des notes : le timestamp (wordTimes) le plus récent gagne.
  mergeNotesByTime(existingNotes, incomingNotes, existingTimes = {}, incomingTimes = {}) {
    const a = safeJsonParse(existingNotes, {});
    const b = safeJsonParse(incomingNotes, {});
    const at = existingTimes || {};
    const bt = incomingTimes || {};
    const merged = {};
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach((key) => {
      const ta = Number(at[key]) || 0;
      const tb = Number(bt[key]) || 0;
      const hasA = a[key] != null;
      const hasB = b[key] != null;
      let useB;
      if (ta !== tb) useB = tb > ta;
      else if (hasA !== hasB) useB = hasB;
      else useB = true; // égalité : l'entrant (push le plus récent) gagne
      merged[key] = useB ? (hasB ? b[key] : a[key]) : (hasA ? a[key] : b[key]);
    });
    return merged;
  },

  // Fusion LWW des positions via posTimes.
  mergePositionsByTime(existingPos, incomingPos, existingTimes = {}, incomingTimes = {}) {
    const a = typeof existingPos === 'string' ? safeJsonParse(existingPos, []) : (existingPos || []);
    const b = typeof incomingPos === 'string' ? safeJsonParse(incomingPos, []) : (incomingPos || []);
    const map = new Map();
    const add = (arr, times, preferOnTie) => {
      (arr || []).forEach((pos) => {
        if (!pos?.word) return;
        const key = pos.word.toLowerCase();
        const ts = Number((times || {})[key]) || 0;
        const existing = map.get(key);
        if (!existing || ts > existing.ts || (ts === existing.ts && preferOnTie)) {
          map.set(key, { pos, ts });
        }
      });
    };
    add(a, existingTimes, false);
    add(b, incomingTimes, true); // entrant gagne à égalité
    return Array.from(map.values()).map((v) => v.pos);
  },

  mergeFoldersByTime(parsedSources) {
    const byId = new Map();
    parsedSources.forEach((s, order) => {
      const times = s.folderTimes || {};
      (s.folders || []).forEach((folder) => {
        if (!folder?.id) return;
        const ts = Number(times[folder.id]) || 0;
        const existing = byId.get(folder.id);
        if (!existing || ts > existing.ts || (ts === existing.ts && order >= existing.order)) {
          byId.set(folder.id, { folder: { ...folder }, ts, order });
        }
      });
    });
    return Array.from(byId.values()).map((v) => v.folder)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },

  mergeNoteFoldersByTime(parsedSources) {
    const byKey = new Map();
    parsedSources.forEach((s, order) => {
      const times = s.noteFolderTimes || {};
      Object.entries(s.noteFolders || {}).forEach(([rawKey, value]) => {
        const key = rawKey.toLowerCase();
        const ts = Number(times[key]) || 0;
        const existing = byKey.get(key);
        if (!existing || ts > existing.ts || (ts === existing.ts && order >= existing.order)) {
          byKey.set(key, { value: value ?? null, ts, order });
        }
      });
    });
    const merged = {};
    byKey.forEach((v, key) => { merged[key] = v.value; });
    return merged;
  },

  mergeNoteExtraFolders(parsedSources) {
    const byKey = new Map();
    parsedSources.forEach((s, order) => {
      const times = s.noteExtraFolderTimes || {};
      Object.entries(s.noteExtraFolders || {}).forEach(([rawKey, value]) => {
        const key = rawKey.toLowerCase();
        const ts = Number(times[key]) || 0;
        const existing = byKey.get(key);
        if (!existing || ts > existing.ts || (ts === existing.ts && order >= existing.order)) {
          byKey.set(key, { value: Array.isArray(value) ? value : [], ts, order });
        }
      });
    });
    const merged = {};
    byKey.forEach((v, key) => { if (v.value.length) merged[key] = v.value; });
    return merged;
  },

  mergeFolders(...sources) {
    const byId = new Map();
    sources.forEach((folders) => {
      let parsed = folders;
      if (typeof folders === 'string') {
        try { parsed = JSON.parse(folders); } catch { parsed = []; }
      }
      (parsed || []).forEach((folder) => {
        if (!folder?.id) return;
        const existing = byId.get(folder.id);
        if (!existing) {
          byId.set(folder.id, { ...folder });
          return;
        }
        byId.set(folder.id, {
          id: folder.id,
          name: (folder.name?.length || 0) >= (existing.name?.length || 0) ? folder.name : existing.name,
          createdAt: existing.createdAt || folder.createdAt,
        });
      });
    });
    return Array.from(byId.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },

  mergeNoteFolders(...sources) {
    const merged = {};
    sources.forEach((noteFolders) => {
      let parsed = noteFolders;
      if (typeof noteFolders === 'string') {
        try { parsed = JSON.parse(noteFolders); } catch { parsed = {}; }
      }
      Object.entries(parsed || {}).forEach(([key, folderId]) => {
        if (folderId) merged[key.toLowerCase()] = folderId;
      });
    });
    return merged;
  },

  mergeNoteDates(...sources) {
    const merged = {};
    sources.forEach((noteDates) => {
      let parsed = noteDates;
      if (typeof noteDates === 'string') {
        try { parsed = JSON.parse(noteDates); } catch { parsed = {}; }
      }
      Object.entries(parsed || {}).forEach(([key, date]) => {
        const k = key.toLowerCase();
        if (!merged[k] || Date.parse(date) < Date.parse(merged[k])) {
          merged[k] = date;
        }
      });
    });
    return merged;
  },

  mergeDiaporamaList(...sources) {
    const seen = new Set();
    const list = [];
    sources.forEach((items) => {
      let parsed = items;
      if (typeof items === 'string') {
        try { parsed = JSON.parse(items); } catch { parsed = []; }
      }
      (parsed || []).forEach((word) => {
        const k = word.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          list.push(word);
        }
      });
    });
    return list;
  },

  mergeHistory(...sources) {
    const seen = new Set();
    const merged = [];
    sources.forEach((history) => {
      const parsed = ensureArray(safeJsonParse(history, []));
      parsed.forEach((entry) => {
        if (!entry?.word) return;
        const key = `${entry.word}|${entry.timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(entry);
        }
      });
    });
    return merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  },

  mergeSettings(...sources) {
    const parsed = sources.map((settings) => {
      if (!settings) return {};
      if (typeof settings === 'string') {
        try { return JSON.parse(settings); } catch { return {}; }
      }
      return settings;
    }).filter((s) => s && typeof s === 'object');
    if (!parsed.length) return '{}';

    const merged = { ...parsed[parsed.length - 1] };
    merged.folders = stmts.mergeFoldersByTime(parsed);
    merged.noteFolders = stmts.mergeNoteFoldersByTime(parsed);
    merged.noteExtraFolders = stmts.mergeNoteExtraFolders(parsed);
    merged.noteExtraFolderTimes = stmts.mergeTimestampMaps(...parsed.map((s) => s.noteExtraFolderTimes));
    merged.noteDates = stmts.mergeNoteDates(...parsed.map((s) => s.noteDates));
    merged.diaporamaList = stmts.mergeDiaporamaList(...parsed.map((s) => s.diaporamaList));
    merged.deletions = stmts.mergeTimestampMaps(...parsed.map((s) => s.deletions));
    merged.wordTimes = stmts.mergeTimestampMaps(...parsed.map((s) => s.wordTimes));
    merged.posTimes = stmts.mergeTimestampMaps(...parsed.map((s) => s.posTimes));
    merged.folderTimes = stmts.mergeTimestampMaps(...parsed.map((s) => s.folderTimes));
    merged.folderDeletions = stmts.mergeTimestampMaps(...parsed.map((s) => s.folderDeletions));
    merged.noteFolderTimes = stmts.mergeTimestampMaps(...parsed.map((s) => s.noteFolderTimes));
    return JSON.stringify(merged);
  },

  mergeTimestampMaps(...sources) {
    const merged = {};
    sources.forEach((map) => {
      let parsed = map;
      if (typeof map === 'string') {
        try { parsed = JSON.parse(map); } catch { parsed = {}; }
      }
      Object.entries(parsed || {}).forEach(([key, ts]) => {
        const k = key.toLowerCase();
        const n = Number(ts) || 0;
        if (!(k in merged) || n > merged[k]) merged[k] = n;
      });
    });
    return merged;
  },

  /**
   * Retire des positions/notes les mots supprimés (tombstones), sauf ceux
   * recréés plus récemment (wordTimes). Nettoie les tombstones expirés.
   * Renvoie { positions, notes, settings } nettoyés.
   */
  applyTombstones(positions, notes, settings) {
    const deletions = settings.deletions || {};
    const wordTimes = settings.wordTimes || {};
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

    // Tombstones de dossiers.
    const folderDeletions = settings.folderDeletions || {};
    const folderTimes = settings.folderTimes || {};
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
    if (deadFolders.size) {
      settings.folders = (settings.folders || []).filter((f) => !deadFolders.has(f.id));
      if (settings.noteFolders) {
        Object.keys(settings.noteFolders).forEach((key) => {
          if (deadFolders.has(settings.noteFolders[key])) settings.noteFolders[key] = null;
        });
      }
      if (settings.noteExtraFolders) {
        Object.keys(settings.noteExtraFolders).forEach((key) => {
          const kept = (settings.noteExtraFolders[key] || []).filter((id) => !deadFolders.has(id));
          if (kept.length) settings.noteExtraFolders[key] = kept;
          else delete settings.noteExtraFolders[key];
        });
      }
    }

    if (!dead.size) return { positions, notes, settings };

    const cleanPositions = (positions || []).filter((p) => p?.word && !dead.has(p.word.toLowerCase()));
    const cleanNotes = { ...notes };
    dead.forEach((key) => { delete cleanNotes[key]; });
    if (settings.noteDates) dead.forEach((key) => { delete settings.noteDates[key]; });
    if (settings.noteFolders) dead.forEach((key) => { delete settings.noteFolders[key]; });
    if (settings.noteExtraFolders) dead.forEach((key) => { delete settings.noteExtraFolders[key]; });
    if (Array.isArray(settings.diaporamaList)) {
      settings.diaporamaList = settings.diaporamaList.filter((w) => !dead.has(String(w).toLowerCase()));
    }
    return { positions: cleanPositions, notes: cleanNotes, settings };
  },

  upsertData(userId, positions, notes, history, settings) {
    return withDataLock(() => {
      const store = loadStore();
      const existing = store.mindmap_data[userId];
      const existingSettings = safeJsonParse(existing?.settings, {});
      const incomingSettings = safeJsonParse(settings, {});
      const mergedNotes = stmts.mergeNotesByTime(
        existing?.notes, notes, existingSettings.wordTimes, incomingSettings.wordTimes,
      );
      const mergedPositions = stmts.mergePositionsByTime(
        existing?.positions, positions, existingSettings.posTimes, incomingSettings.posTimes,
      );
      const mergedHistory = stmts.mergeHistory(existing?.history, history);
      const mergedSettingsObj = safeJsonParse(stmts.mergeSettings(existing?.settings, settings), {});
      const cleaned = stmts.applyTombstones(mergedPositions, mergedNotes, mergedSettingsObj);
      store.mindmap_data[userId] = {
        positions: JSON.stringify(cleaned.positions),
        notes: JSON.stringify(cleaned.notes),
        history: JSON.stringify(mergedHistory),
        settings: JSON.stringify(cleaned.settings),
        updated_at: new Date().toISOString(),
      };
      saveStore(store);
      return store.mindmap_data[userId];
    });
  },

  exportUserData(userId) {
    const row = stmts.getData(userId);
    if (!row) return null;
    return {
      positions: JSON.parse(row.positions),
      notes: JSON.parse(row.notes),
      history: JSON.parse(row.history),
      settings: JSON.parse(row.settings),
      exportedAt: new Date().toISOString(),
    };
  },

  importUserData(userId, data) {
    return stmts.upsertData(
      userId,
      JSON.stringify(data.positions || []),
      JSON.stringify(data.notes || {}),
      JSON.stringify(data.history || []),
      JSON.stringify(data.settings || {}),
    );
  },
};

module.exports = {
  init,
  stmts,
  bcrypt,
  getStorageInfo,
  getDataVersion,
  saveImageDataUri,
  readImageDataUri,
  writeImageFromDataUri,
  dataDir,
  imagesDir,
  DEFAULT_USER_ID,
  ensureDefaultUser,
  listBackupSnapshots,
  restoreFromBackup,
};
