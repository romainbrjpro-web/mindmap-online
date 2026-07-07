/**
 * Server sync — authentification et synchronisation cloud
 */

const Sync = {
  token: localStorage.getItem('mindmap_token') || null,
  email: localStorage.getItem('mindmap_email') || null,
  syncTimer: null,
  isSyncing: false,

  get headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  },

  setAuth(token, email) {
    this.token = token;
    this.email = email;
    localStorage.setItem('mindmap_token', token);
    localStorage.setItem('mindmap_email', email);
  },

  clearAuth() {
    this.token = null;
    this.email = null;
    localStorage.removeItem('mindmap_token');
    localStorage.removeItem('mindmap_email');
  },

  isLoggedIn() {
    return !!this.token;
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

  async register(email, password) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur inscription');
    this.setAuth(data.token, data.email);
    return data;
  },

  async login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur connexion');
    this.setAuth(data.token, data.email);
    return data;
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
    if (!this.isLoggedIn()) return;
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
