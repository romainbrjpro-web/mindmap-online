/**
 * Server sync — sauvegarde cloud sans connexion
 */

const Sync = {
  syncTimer: null,
  isSyncing: false,

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
    const res = await fetch('/api/data', {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur sauvegarde');
    return data;
  },

  scheduleSync(getPayload) {
    if (!this.isServerMode()) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      if (this.isSyncing) return;
      this.isSyncing = true;
      this.setStatus('syncing', '☁️ Sync…');
      try {
        await this.pushData(getPayload());
        this.setStatus('synced', '☁️ Sync ✓');
        setTimeout(() => this.setStatus('hidden'), 2000);
      } catch (e) {
        this.setStatus('error', '☁️ Erreur');
        console.error('Sync error:', e);
      } finally {
        this.isSyncing = false;
      }
    }, 800);
  },
};
