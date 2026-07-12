/**
 * Server sync — sauvegarde cloud sans connexion
 */

const SAVE_INTERVAL_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 30000;
const SYNC_DEBOUNCE_MS = 800;

function parseSettings(settings) {
  if (!settings) return {};
  if (typeof settings === 'string') {
    try { return JSON.parse(settings); } catch { return {}; }
  }
  return settings;
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

/** À l'envoi : le contenu local l'emporte (c'est une sauvegarde volontaire). */
function mergeNotesOnPush(serverNotes, localNotes) {
  const merged = { ...(serverNotes || {}) };
  Object.entries(localNotes || {}).forEach(([key, content]) => {
    if (content != null) merged[key] = content;
  });
  return merged;
}

/**
 * À la lecture : le serveur fait autorité sur les notes qu'il possède
 * (corrige l'affichage de versions périmées), mais on conserve les notes
 * locales absentes du serveur (ajouts hors-ligne) et les éditions en cours
 * non encore synchronisées (protectedKeys), pour ne jamais perdre de données.
 */
function mergeNotesOnPull(localNotes, serverNotes, protectedKeys = new Set()) {
  const merged = { ...(localNotes || {}) };
  Object.entries(serverNotes || {}).forEach(([key, content]) => {
    if (content != null) merged[key] = content;
  });
  protectedKeys.forEach((key) => {
    const k = key.toLowerCase();
    if (localNotes?.[k] != null) merged[k] = localNotes[k];
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

function mergeFolders(...sources) {
  const byId = new Map();
  sources.forEach((folders) => {
    (folders || []).forEach((folder) => {
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
}

function mergeNoteFolders(...sources) {
  const merged = {};
  sources.forEach((noteFolders) => {
    Object.entries(noteFolders || {}).forEach(([key, folderId]) => {
      if (folderId) merged[key.toLowerCase()] = folderId;
    });
  });
  return merged;
}

function mergeNoteDates(...sources) {
  const merged = {};
  sources.forEach((noteDates) => {
    Object.entries(noteDates || {}).forEach(([key, date]) => {
      const k = key.toLowerCase();
      if (!merged[k] || Date.parse(date) < Date.parse(merged[k])) {
        merged[k] = date;
      }
    });
  });
  return merged;
}

/**
 * Fusion LWW du contenu des notes : pour chaque clé, la source dont
 * wordTimes est le plus récent gagne. À égalité, `tiebreak` décide.
 * Les clés protégées (édition en cours) restent locales.
 */
function mergeNotesByTime(localNotes, serverNotes, localTimes = {}, serverTimes = {}, protectedKeys = new Set(), tiebreak = 'server') {
  const local = localNotes || {};
  const server = serverNotes || {};
  const merged = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(server)]);
  keys.forEach((key) => {
    const lt = Number(localTimes[key]) || 0;
    const st = Number(serverTimes[key]) || 0;
    const hasLocal = local[key] != null;
    const hasServer = server[key] != null;
    let useLocal;
    if (lt !== st) useLocal = lt > st;
    else if (hasLocal !== hasServer) useLocal = hasLocal;
    else useLocal = (tiebreak === 'local');
    merged[key] = useLocal
      ? (hasLocal ? local[key] : server[key])
      : (hasServer ? server[key] : local[key]);
  });
  protectedKeys.forEach((pk) => {
    const k = pk.toLowerCase();
    if (local[k] != null) merged[k] = local[k];
  });
  return merged;
}

/**
 * Fusion LWW des positions : pour chaque mot, la source dont posTimes
 * est le plus récent gagne (placement/déplacement le plus récent).
 */
function mergePositionsByTime(localPos, serverPos, localTimes = {}, serverTimes = {}, tiebreak = 'server') {
  const map = new Map();
  const add = (arr, times, source) => {
    (arr || []).forEach((pos) => {
      if (!pos?.word) return;
      const key = pos.word.toLowerCase();
      const ts = Number(times[key]) || 0;
      const existing = map.get(key);
      if (!existing || ts > existing.ts || (ts === existing.ts && source === tiebreak && existing.source !== tiebreak)) {
        map.set(key, { pos, ts, source });
      }
    });
  };
  add(localPos, localTimes, 'local');
  add(serverPos, serverTimes, 'server');
  return Array.from(map.values()).map((v) => v.pos);
}

/** Fusion LWW des dossiers (nom) via folderTimes; dernière source = base sur égalité. */
function mergeFoldersByTime(parsedSources) {
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
}

/** Fusion LWW des affectations de dossier via noteFolderTimes; conserve null (désaffectation). */
function mergeNoteFoldersByTime(parsedSources) {
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
}

function mergeDiaporamaList(...sources) {
  const seen = new Set();
  const list = [];
  sources.forEach((items) => {
    (items || []).forEach((word) => {
      const k = word.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        list.push(word);
      }
    });
  });
  return list;
}

// Fusionne des maps { clé: timestamp } en gardant le timestamp le plus récent.
function mergeTimestampMaps(...sources) {
  const merged = {};
  sources.forEach((map) => {
    Object.entries(map || {}).forEach(([key, ts]) => {
      const k = key.toLowerCase();
      const n = Number(ts) || 0;
      if (!(k in merged) || n > merged[k]) merged[k] = n;
    });
  });
  return merged;
}

function mergeHistory(...sources) {
  const seen = new Set();
  const merged = [];
  sources.forEach((history) => {
    (history || []).forEach((entry) => {
      if (!entry?.word) return;
      const key = `${entry.word}|${entry.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    });
  });
  return merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
}

function mergeSettings(...sources) {
  const parsed = sources.map(parseSettings).filter((s) => s && typeof s === 'object');
  if (!parsed.length) return {};

  const merged = { ...parsed[parsed.length - 1] };
  merged.folders = mergeFoldersByTime(parsed);
  merged.noteFolders = mergeNoteFoldersByTime(parsed);
  merged.noteDates = mergeNoteDates(...parsed.map((s) => s.noteDates));
  merged.diaporamaList = mergeDiaporamaList(...parsed.map((s) => s.diaporamaList));
  merged.deletions = mergeTimestampMaps(...parsed.map((s) => s.deletions));
  merged.wordTimes = mergeTimestampMaps(...parsed.map((s) => s.wordTimes));
  merged.posTimes = mergeTimestampMaps(...parsed.map((s) => s.posTimes));
  merged.folderTimes = mergeTimestampMaps(...parsed.map((s) => s.folderTimes));
  merged.folderDeletions = mergeTimestampMaps(...parsed.map((s) => s.folderDeletions));
  merged.noteFolderTimes = mergeTimestampMaps(...parsed.map((s) => s.noteFolderTimes));
  return merged;
}

function mergePayloadWithSnapshot(payload, snapshot, protectedNoteKeys = new Set()) {
  if (!snapshot) return payload;
  return {
    ...payload,
    positions: mergePositions(snapshot.positions, payload.positions),
    notes: mergeNotesOnPush(snapshot.notes, payload.notes),
    history: mergeHistory(snapshot.history, payload.history),
    settings: mergeSettings(snapshot.settings, payload.settings),
  };
}

const Sync = {
  syncTimer: null,
  isSyncing: false,
  lastPayload: null,
  lastServerUpdatedAt: 0,
  lastServerSnapshot: null,
  pollTimer: null,
  periodicTimer: null,
  onRemoteUpdate: null,
  getPayload: null,
  getProtectedNoteKeys: null,

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
  },

  fetchOptions() {
    return { cache: 'no-store', headers: this.headers };
  },

  isServerMode() {
    return location.protocol !== 'file:';
  },

  setServerTimestamp(updatedAt) {
    this.lastServerUpdatedAt = updatedAt ? Date.parse(updatedAt) : 0;
  },

  rememberServerData(data) {
    if (!data) return;
    this.lastServerSnapshot = {
      positions: data.positions || [],
      notes: data.notes || {},
      history: data.history || [],
      settings: data.settings || {},
      updated_at: data.updated_at || null,
    };
    if (data.updated_at) this.setServerTimestamp(data.updated_at);
  },

  setStatus(state, text) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.classList.remove('hidden', 'syncing', 'synced', 'error');
    if (state === 'hidden') {
      el.classList.add('hidden');
      return;
    }
    el.classList.add(state);
    el.textContent = text;
  },

  async fetchVersion() {
    const res = await fetch(`/api/data/version?_=${Date.now()}`, this.fetchOptions());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur version');
    return data.updated_at || null;
  },

  async fetchData() {
    const res = await fetch(`/api/data?_=${Date.now()}`, this.fetchOptions());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur chargement');
    this.rememberServerData(data);
    return data;
  },

  async pushData(payload, options = {}) {
    if (options.refreshBeforePush) {
      try {
        await this.fetchData();
      } catch {
        /* use cached snapshot if refresh fails */
      }
    }
    let safePayload = payload;
    if (!options.skipMerge) {
      const protectedKeys = typeof this.getProtectedNoteKeys === 'function'
        ? this.getProtectedNoteKeys()
        : new Set();
      safePayload = mergePayloadWithSnapshot(payload, this.lastServerSnapshot, protectedKeys);
    }
    this.lastPayload = safePayload;
    const res = await fetch('/api/data', {
      method: 'PUT',
      ...this.fetchOptions(),
      body: JSON.stringify(safePayload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur sauvegarde');
    if (data.updated_at) this.setServerTimestamp(data.updated_at);
    if (typeof this.onPushSuccess === 'function') this.onPushSuccess(safePayload);
    return data;
  },

  scheduleSync(getPayload, immediate = false) {
    if (!this.isServerMode()) return;
    this.getPayload = getPayload;
    if (typeof getPayload === 'function') {
      this.lastPayload = getPayload();
    }
    clearTimeout(this.syncTimer);

    if (immediate) {
      this.runSync(getPayload);
      return;
    }

    this.syncTimer = setTimeout(() => this.runSync(getPayload), SYNC_DEBOUNCE_MS);
  },

  async runSync(getPayload) {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.setStatus('syncing', '☁️ Sync…');
    try {
      const payload = typeof getPayload === 'function' ? getPayload() : getPayload;
      await this.pushData(payload);
      this.setStatus('synced', '☁️ Sync ✓');
      setTimeout(() => this.setStatus('hidden'), 2000);
    } catch (e) {
      this.setStatus('error', '☁️ Erreur sync');
      console.error('Sync error:', e);
    } finally {
      this.isSyncing = false;
    }
  },

  flushSync(getPayload) {
    if (!this.isServerMode()) return;
    clearTimeout(this.syncTimer);
    const payload = typeof getPayload === 'function' ? getPayload() : getPayload;
    const safePayload = mergePayloadWithSnapshot(payload, this.lastServerSnapshot);
    this.lastPayload = safePayload;
    fetch('/api/data', {
      method: 'PUT',
      ...this.fetchOptions(),
      body: JSON.stringify(safePayload),
      keepalive: true,
    })
      .then((res) => res.json())
      .then((data) => { if (data.updated_at) this.setServerTimestamp(data.updated_at); })
      .catch((e) => console.error('Flush sync error:', e));
  },

  async pullLatest(force = false) {
    let serverTime = 0;
    try {
      const updatedAt = await this.fetchVersion();
      serverTime = updatedAt ? Date.parse(updatedAt) : 0;
    } catch (e) {
      console.error('Version check failed, full pull:', e);
      const data = await this.fetchData();
      if (this.onRemoteUpdate) this.onRemoteUpdate(data);
      return data;
    }

    if (!force && serverTime <= this.lastServerUpdatedAt) {
      return null;
    }

    const data = await this.fetchData();
    if (this.onRemoteUpdate) this.onRemoteUpdate(data);
    return data;
  },

  startPolling(onRemoteUpdate) {
    if (!this.isServerMode() || this.pollTimer) return;
    this.onRemoteUpdate = onRemoteUpdate;
    this.pollTimer = setInterval(async () => {
      try {
        await this.pullLatest(false);
      } catch { /* ignore transient errors */ }
    }, POLL_INTERVAL_MS);
  },

  startPeriodicSave(getPayload) {
    if (!this.isServerMode() || this.periodicTimer) return;
    this.getPayload = getPayload;
    this.periodicTimer = setInterval(async () => {
      try {
        await this.runSync(getPayload);
        await this.pullLatest(true);
      } catch (e) {
        console.error('Periodic sync error:', e);
      }
    }, SAVE_INTERVAL_MS);
  },

  initLifecycle(getPayload, onRemoteUpdate, options = {}) {
    if (!this.isServerMode()) return;
    this.getPayload = getPayload;
    this.onRemoteUpdate = onRemoteUpdate;
    this.getProtectedNoteKeys = options.getProtectedNoteKeys || null;
    this.onPushSuccess = options.onPushSuccess || null;

    window.addEventListener('pagehide', () => {
      if (getPayload) this.flushSync(getPayload);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (getPayload) this.flushSync(getPayload);
        return;
      }
      this.pullLatest(true).catch((e) => console.error('Visibility pull error:', e));
    });

    window.addEventListener('focus', () => {
      this.pullLatest(true).catch((e) => console.error('Focus pull error:', e));
    });

    window.addEventListener('online', () => {
      this.runSync(getPayload).catch((e) => console.error('Online sync error:', e));
      this.pullLatest(true).catch((e) => console.error('Online pull error:', e));
    });

    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        this.pullLatest(true).catch((err) => console.error('Pageshow pull error:', err));
      }
    });
  },
};

if (typeof window !== 'undefined') {
  window.Sync = Sync;
  window.mergeNotesKeepLonger = mergeNotesKeepLonger;
  window.mergeNotesOnPush = mergeNotesOnPush;
  window.mergeNotesOnPull = mergeNotesOnPull;
  window.mergePositions = mergePositions;
  window.mergeFolders = mergeFolders;
  window.mergeNoteFolders = mergeNoteFolders;
  window.mergeSettings = mergeSettings;
  window.mergeHistory = mergeHistory;
}
