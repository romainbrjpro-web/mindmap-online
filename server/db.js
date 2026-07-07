const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'store.json');
const backupDir = path.join(dataDir, 'backups');
const MAX_BACKUPS = 30;

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
}

ensureDirs();

function loadStore() {
  if (!fs.existsSync(dbFile)) {
    return { users: [], mindmap_data: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch (e) {
    console.error('Erreur lecture store.json, tentative backup…', e.message);
    const restored = restoreLatestBackup();
    if (restored) return restored;
    return { users: [], mindmap_data: {} };
  }
}

function listBackups() {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
}

function restoreLatestBackup() {
  const backups = listBackups();
  for (const file of backups) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));
      fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
      console.log(`✅ Données restaurées depuis ${file}`);
      return data;
    } catch { /* try next */ }
  }
  return null;
}

function createBackup(store) {
  try {
    const name = `store-${Date.now()}.json`;
    fs.writeFileSync(path.join(backupDir, name), JSON.stringify(store, null, 2));
    const all = listBackups();
    if (all.length > MAX_BACKUPS) {
      all.slice(MAX_BACKUPS).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* ignore */ }
      });
    }
  } catch (e) {
    console.warn('Backup échoué:', e.message);
  }
}

function saveStore(store) {
  const json = JSON.stringify(store, null, 2);
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, dbFile);
  createBackup(store);
}

function getStorageInfo() {
  const stats = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    dataDir,
    dbFile,
    exists: !!stats,
    sizeBytes: stats?.size || 0,
    backupCount: listBackups().length,
    lastModified: stats?.mtime?.toISOString() || null,
  };
}

const DEFAULT_USER_ID = 1;

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

ensureDefaultUser();

const stmts = {
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
    stmts.upsertData(
      userId,
      JSON.stringify(data.positions || []),
      JSON.stringify(data.notes || {}),
      JSON.stringify(data.history || []),
      JSON.stringify(data.settings || {}),
    );
  },
};

module.exports = { stmts, bcrypt, getStorageInfo, dataDir, DEFAULT_USER_ID, ensureDefaultUser };
