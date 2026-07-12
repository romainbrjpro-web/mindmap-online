/**
 * Server sync — sauvegarde cloud sans connexion
 */

const SAVE_INTERVAL_MS = 15 * 60 * 1000; // sauvegarde automatique toutes les 15 min
const POLL_INTERVAL_MS = 8000; // vérification des mises à jour distantes

function mergeNotesKeepLonger(...sources) {
  const merged = {};
  sources.forEach((notes) => {
    Object.entries(notes || {}).forEach(([key, content]) => {
      const existing = merged[key] || '';
      if ((content?.length || 0) > (existing?.length || 0)) {
        merged[key] = content;
      }
    });
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

function mergePayloadWithSnapshot(payload, snapshot) {
  if (!snapshot) return payload;
  return {
    ...payload,
    positions: mergePositions(snapshot.positions, payload.positions),
    notes: mergeNotesKeepLonger(snapshot.notes, payload.notes),
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

  async fetchData() {
    const res = await fetch(`/api/data?_=${Date.now()}`, this.fetchOptions());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur chargement');
    this.rememberServerData(data);
    return data;
  },

  async pushData(payload, options = {}) {
    let safePayload = payload;
    if (!options.skipMerge) {
      safePayload = mergePayloadWithSnapshot(payload, this.lastServerSnapshot);
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

    this.syncTimer = setTimeout(() => this.runSync(getPayload), 200);
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
    const data = await this.fetchData();
    const serverTime = data.updated_at ? Date.parse(data.updated_at) : 0;
    if (force || serverTime > this.lastServerUpdatedAt) {
      if (this.onRemoteUpdate) this.onRemoteUpdate(data);
    }
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

  initLifecycle(getPayload, onRemoteUpdate) {
    if (!this.isServerMode()) return;
    this.getPayload = getPayload;
    this.onRemoteUpdate = onRemoteUpdate;

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
  window.mergePositions = mergePositions;
}
