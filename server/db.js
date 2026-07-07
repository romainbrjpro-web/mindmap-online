const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DEFAULT_USER_ID = 1;
const MAX_BACKUPS = 30;

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'store.json');
const backupDir = path.join(dataDir, 'backups');

let pool = null;
let storageMode = 'json';

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

async function initPostgres(connectionString) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    connectionTimeoutMillis: 5000,
  });

  // Test connexion rapide — évite de bloquer le démarrage (502 Render)
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mindmap_data (
      user_id INTEGER PRIMARY KEY,
      positions JSONB NOT NULL DEFAULT '[]',
      notes JSONB NOT NULL DEFAULT '{}',
      history JSONB NOT NULL DEFAULT '[]',
      settings JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mindmap_backups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      positions JSONB NOT NULL,
      notes JSONB NOT NULL,
      history JSONB NOT NULL,
      settings JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mindmap_backups_user_created
      ON mindmap_backups (user_id, created_at DESC);
  `);

  const { rows } = await pool.query('SELECT 1 FROM mindmap_data WHERE user_id = $1', [DEFAULT_USER_ID]);
  if (!rows.length) {
    await pool.query(
      `INSERT INTO mindmap_data (user_id, positions, notes, history, settings)
       VALUES ($1, '[]', '{}', '[]', '{}')`,
      [DEFAULT_USER_ID],
    );
  }

  storageMode = 'postgresql';
  console.log('✅ Base PostgreSQL connectée — données persistantes');

  await migrateJsonToPostgres();
}

async function migrateJsonToPostgres() {
  if (!fs.existsSync(dbFile)) return;

  const { rows } = await pool.query(
    `SELECT positions, notes, history, settings
     FROM mindmap_data WHERE user_id = $1`,
    [DEFAULT_USER_ID],
  );
  const row = rows[0];
  const isEmpty =
    (row.positions?.length || 0) === 0 &&
    Object.keys(row.notes || {}).length === 0 &&
    (row.history?.length || 0) === 0;

  if (!isEmpty) return;

  try {
    const store = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const data = store.mindmap_data?.[DEFAULT_USER_ID];
    if (!data) return;

    const positions = JSON.parse(data.positions || '[]');
    const notes = JSON.parse(data.notes || '{}');
    const history = JSON.parse(data.history || '[]');
    const settings = JSON.parse(data.settings || '{}');
    const hasData = positions.length > 0 || Object.keys(notes).length > 0 || history.length > 0;
    if (!hasData) return;

    await pool.query(
      `UPDATE mindmap_data
       SET positions = $2, notes = $3, history = $4, settings = $5, updated_at = NOW()
       WHERE user_id = $1`,
      [DEFAULT_USER_ID, positions, notes, history, settings],
    );
    console.log('📦 Données migrées depuis store.json vers PostgreSQL');
  } catch (e) {
    console.warn('Migration JSON → PostgreSQL ignorée:', e.message);
  }
}

async function pgCreateBackup(userId, positions, notes, history, settings) {
  await pool.query(
    `INSERT INTO mindmap_backups (user_id, positions, notes, history, settings)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, positions, notes, history, settings],
  );

  await pool.query(
    `DELETE FROM mindmap_backups
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM mindmap_backups
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       )`,
    [userId, MAX_BACKUPS],
  );
}

const pgStmts = {
  async createUser(email, passwordHash) {
    return { lastInsertRowid: DEFAULT_USER_ID };
  },

  async findUserByEmail(email) {
    return null;
  },

  async findUserById(id) {
    return { id: DEFAULT_USER_ID, email: 'default@mindmap.local', created_at: new Date().toISOString() };
  },

  async getData(userId) {
    const { rows } = await pool.query(
      'SELECT positions, notes, history, settings, updated_at FROM mindmap_data WHERE user_id = $1',
      [userId],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      positions: JSON.stringify(row.positions),
      notes: JSON.stringify(row.notes),
      history: JSON.stringify(row.history),
      settings: JSON.stringify(row.settings),
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  },

  async upsertData(userId, positions, notes, history, settings) {
    const positionsObj = typeof positions === 'string' ? JSON.parse(positions) : positions;
    const notesObj = typeof notes === 'string' ? JSON.parse(notes) : notes;
    const historyObj = typeof history === 'string' ? JSON.parse(history) : history;
    const settingsObj = typeof settings === 'string' ? JSON.parse(settings) : settings;

    await pool.query(
      `INSERT INTO mindmap_data (user_id, positions, notes, history, settings, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         positions = EXCLUDED.positions,
         notes = EXCLUDED.notes,
         history = EXCLUDED.history,
         settings = EXCLUDED.settings,
         updated_at = NOW()`,
      [userId, positionsObj, notesObj, historyObj, settingsObj],
    );

    await pgCreateBackup(userId, positionsObj, notesObj, historyObj, settingsObj);
  },

  async exportUserData(userId) {
    const row = await pgStmts.getData(userId);
    if (!row) return null;
    return {
      positions: JSON.parse(row.positions),
      notes: JSON.parse(row.notes),
      history: JSON.parse(row.history),
      settings: JSON.parse(row.settings),
      exportedAt: new Date().toISOString(),
    };
  },

  async importUserData(userId, data) {
    await pgStmts.upsertData(
      userId,
      JSON.stringify(data.positions || []),
      JSON.stringify(data.notes || {}),
      JSON.stringify(data.history || []),
      JSON.stringify(data.settings || {}),
    );
  },
};

async function getPgStorageInfo() {
  const data = await pgStmts.getData(DEFAULT_USER_ID);
  const notes = data ? JSON.parse(data.notes) : {};
  const positions = data ? JSON.parse(data.positions) : {};
  const { rows: backupRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM mindmap_backups WHERE user_id = $1',
    [DEFAULT_USER_ID],
  );
  return {
    mode: 'postgresql',
    persistent: true,
    noteCount: Object.keys(notes).length,
    wordCount: Array.isArray(positions) ? positions.length : 0,
    backupCount: backupRows[0]?.count || 0,
    updated_at: data?.updated_at || null,
  };
}

// ─── JSON file (dev local uniquement) ─────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
}

function loadStore() {
  if (!fs.existsSync(dbFile)) {
    return { users: [], mindmap_data: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch (e) {
    console.error('Erreur lecture store.json:', e.message);
    return { users: [], mindmap_data: {} };
  }
}

function saveStore(store) {
  const json = JSON.stringify(store, null, 2);
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, dbFile);

  try {
    const name = `store-${Date.now()}.json`;
    fs.writeFileSync(path.join(backupDir, name), json);
    const all = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort().reverse();
    all.slice(MAX_BACKUPS).forEach(f => {
      try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* ignore */ }
    });
  } catch (e) {
    console.warn('Backup fichier échoué:', e.message);
  }
}

function ensureDefaultUserJson() {
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
}

const jsonStmts = {
  createUser(email, passwordHash) {
    const store = loadStore();
    const user = {
      id: store.users.length ? Math.max(...store.users.map(u => u.id)) + 1 : 1,
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
    return store.users.find(u => u.email === email.toLowerCase()) || null;
  },

  findUserById(id) {
    const store = loadStore();
    const user = store.users.find(u => u.id === id);
    if (!user) return null;
    return { id: user.id, email: user.email, created_at: user.created_at };
  },

  getData(userId) {
    const store = loadStore();
    return store.mindmap_data[userId] || null;
  },

  upsertData(userId, positions, notes, history, settings) {
    const store = loadStore();
    store.mindmap_data[userId] = {
      positions,
      notes,
      history,
      settings,
      updated_at: new Date().toISOString(),
    };
    saveStore(store);
  },

  exportUserData(userId) {
    const row = jsonStmts.getData(userId);
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
    jsonStmts.upsertData(
      userId,
      JSON.stringify(data.positions || []),
      JSON.stringify(data.notes || {}),
      JSON.stringify(data.history || []),
      JSON.stringify(data.settings || {}),
    );
  },
};

function getJsonStorageInfo() {
  const stats = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  const data = jsonStmts.getData(DEFAULT_USER_ID);
  const notes = data ? JSON.parse(data.notes) : {};
  const positions = data ? JSON.parse(data.positions) : [];
  return {
    mode: 'json-file',
    persistent: false,
    warning: 'Stockage fichier local — les données sont PERDUES au redéploiement Render. Définissez DATABASE_URL.',
    dataDir,
    noteCount: Object.keys(notes).length,
    wordCount: positions.length,
    backupCount: fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).length : 0,
    sizeBytes: stats?.size || 0,
    updated_at: data?.updated_at || null,
  };
}

// ─── API publique ─────────────────────────────────────────────────────────────

let activeStmts = jsonStmts;

async function init() {
  if (process.env.DATABASE_URL) {
    try {
      await Promise.race([
        initPostgres(process.env.DATABASE_URL),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout connexion PostgreSQL (8s)')), 8000),
        ),
      ]);
      activeStmts = pgStmts;
      return;
    } catch (e) {
      console.error('❌ PostgreSQL indisponible, fallback fichier:', e.message);
      if (pool) {
        try { await pool.end(); } catch { /* ignore */ }
        pool = null;
      }
    }
  }

  ensureDirs();
  ensureDefaultUserJson();
  storageMode = 'json';
  activeStmts = jsonStmts;
  console.warn('⚠️  Stockage fichier (NON persistant sur Render sans DATABASE_URL)');
}

function ensureDefaultUser() {
  if (storageMode === 'json') ensureDefaultUserJson();
  return DEFAULT_USER_ID;
}

async function getStorageInfo() {
  if (storageMode === 'postgresql') return getPgStorageInfo();
  return getJsonStorageInfo();
}

const stmts = {
  createUser: (...args) => activeStmts.createUser(...args),
  findUserByEmail: (...args) => activeStmts.findUserByEmail(...args),
  findUserById: (...args) => activeStmts.findUserById(...args),
  getData: (...args) => activeStmts.getData(...args),
  upsertData: (...args) => activeStmts.upsertData(...args),
  exportUserData: (...args) => activeStmts.exportUserData(...args),
  importUserData: (...args) => activeStmts.importUserData(...args),
};

module.exports = { init, stmts, bcrypt, getStorageInfo, dataDir, DEFAULT_USER_ID, ensureDefaultUser };
