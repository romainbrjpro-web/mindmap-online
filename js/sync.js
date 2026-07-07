/**
 * Server sync — sauvegarde cloud sans connexion
 */

const Sync = {
  syncTimer: null,
  isSyncing: false,
  lastPayload: null,

  get headers() {
    return { 'Content-Type': 'application/json' };
  },

  isServerMode() {
    return location.protocol !== 'file:';
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
    return data;
  },

  scheduleSync(getPayload, immediate = false) {
    if (!this.isServerMode()) return;
    clearTimeout(this.syncTimer);

    if (immediate) {
      this.runSync(getPayload);
      return;
    }

    this.syncTimer = setTimeout(() => this.runSync(getPayload), 300);
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
    }).catch((e) => console.error('Flush sync error:', e));
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
