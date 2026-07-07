/**
 * Server sync — sauvegarde cloud sans connexion
 */

const Sync = {
  syncTimer: null,
  isSyncing: false,
  lastPayload: null,
  lastServerUpdatedAt: 0,
  pollTimer: null,

  get headers() {
    return { 'Content-Type': 'application/json' };
  },

  isServerMode() {
    return location.protocol !== 'file:';
  },

  setServerTimestamp(updatedAt) {
    this.lastServerUpdatedAt = updatedAt ? Date.parse(updatedAt) : 0;
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
    const res = await fetch('/api/data', { headers: this.headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur chargement');
    return data;
  },

  async pushData(payload) {
    this.lastPayload = payload;
    const res = await fetch('/api/data', {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur sauvegarde');
    if (data.updated_at) this.setServerTimestamp(data.updated_at);
    return data;
  },

  scheduleSync(getPayload, immediate = false) {
    if (!this.isServerMode()) return;
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
    this.lastPayload = payload;
    fetch('/api/data', {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(payload),
      keepalive: true,
    })
      .then((res) => res.json())
      .then((data) => { if (data.updated_at) this.setServerTimestamp(data.updated_at); })
      .catch((e) => console.error('Flush sync error:', e));
  },

  startPolling(onRemoteUpdate) {
    if (!this.isServerMode() || this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const data = await this.fetchData();
        const serverTime = data.updated_at ? Date.parse(data.updated_at) : 0;
        if (serverTime > this.lastServerUpdatedAt) {
          this.setServerTimestamp(data.updated_at);
          onRemoteUpdate(data);
        }
      } catch { /* ignore transient errors */ }
    }, 4000);
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (Sync.lastPayload) Sync.flushSync(Sync.lastPayload);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && Sync.lastPayload) {
      Sync.flushSync(Sync.lastPayload);
    }
  });
}
