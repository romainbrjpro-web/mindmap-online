require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { init, stmts, getStorageInfo, getDataVersion, saveImageDataUri, readImageDataUri, writeImageFromDataUri, dataDir, imagesDir, DEFAULT_USER_ID, listBackupSnapshots, restoreFromBackup } = require('./db');

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
const { generateNote } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ROOT = path.join(__dirname, '..');

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function signToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email et mot de passe (6+ caractères) requis' });
  }

  const normalized = email.trim().toLowerCase();
  if (stmts.findUserByEmail(normalized)) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  }

  const hash = await bcrypt.hash(password, 10);
  const result = stmts.createUser(normalized, hash);
  const token = signToken(result.lastInsertRowid, normalized);
  res.json({ token, email: normalized });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  const user = stmts.findUserByEmail(email.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }

  res.json({ token: signToken(user.id, user.email), email: user.email });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = stmts.findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ email: user.email });
});

// ─── Data sync ───────────────────────────────────────────────────────────────

app.get('/api/data/version', (_req, res) => {
  try {
    res.json({ updated_at: getDataVersion(DEFAULT_USER_ID) });
  } catch (e) {
    console.error('GET /api/data/version:', e);
    res.status(500).json({ error: 'Erreur version' });
  }
});

app.get('/api/data', (req, res) => {
  try {
    const row = stmts.getData(DEFAULT_USER_ID);
    if (!row) {
      return res.json({
        positions: [],
        notes: {},
        history: [],
        settings: {},
        updated_at: null,
      });
    }

    res.json({
      positions: safeJsonParse(row.positions, []),
      notes: safeJsonParse(row.notes, {}),
      history: safeJsonParse(row.history, []),
      settings: safeJsonParse(row.settings, {}),
      updated_at: row.updated_at,
    });
  } catch (e) {
    console.error('GET /api/data:', e);
    res.status(500).json({ error: 'Erreur lecture des données' });
  }
});

app.put('/api/data', async (req, res) => {
  try {
    const { positions, notes, history, settings } = req.body;
    if (!Array.isArray(positions) || typeof notes !== 'object') {
      return res.status(400).json({ error: 'Données invalides' });
    }

    const row = await stmts.upsertData(
      DEFAULT_USER_ID,
      JSON.stringify(positions),
      JSON.stringify(notes || {}),
      JSON.stringify(history || []),
      JSON.stringify(settings || {}),
    );

    res.json({ ok: true, updated_at: row.updated_at });
  } catch (e) {
    console.error('PUT /api/data:', e);
    res.status(500).json({ error: 'Erreur sauvegarde' });
  }
});

app.get('/api/data/backup', (req, res) => {
  const data = stmts.exportUserData(DEFAULT_USER_ID);
  if (!data) return res.status(404).json({ error: 'Aucune donnée' });
  res.setHeader('Content-Disposition', `attachment; filename="mindmap-backup-${Date.now()}.json"`);
  res.json(data);
});

// Sauvegarde complète : textes + images intégrées (auto-suffisante, hors-site)
app.get('/api/data/full-backup', (req, res) => {
  try {
    const data = stmts.exportUserData(DEFAULT_USER_ID);
    if (!data) return res.status(404).json({ error: 'Aucune donnée' });

    const scan = JSON.stringify(data.notes || {}) + JSON.stringify(data.settings || {});
    const refs = [...new Set(scan.match(/\/images\/[A-Za-z0-9._-]+/g) || [])];
    const images = {};
    refs.forEach((url) => {
      const uri = readImageDataUri(url);
      if (uri) images[url] = uri;
    });

    res.setHeader('Content-Disposition', `attachment; filename="mindmap-full-backup-${Date.now()}.json"`);
    res.json({ version: 2, ...data, images });
  } catch (e) {
    console.error('GET /api/data/full-backup:', e);
    res.status(500).json({ error: 'Erreur sauvegarde complète' });
  }
});

app.post('/api/data/full-restore', async (req, res) => {
  try {
    const { positions, notes, history, settings, images } = req.body;
    if (!Array.isArray(positions)) {
      return res.status(400).json({ error: 'Fichier de sauvegarde invalide' });
    }
    let restoredImages = 0;
    if (images && typeof images === 'object') {
      for (const [url, dataUri] of Object.entries(images)) {
        try {
          if (writeImageFromDataUri(url, dataUri)) restoredImages += 1;
        } catch (imgErr) {
          console.error('Restore image échouée:', url, imgErr.message);
        }
      }
    }
    const row = await stmts.importUserData(DEFAULT_USER_ID, { positions, notes, history, settings });
    res.json({ ok: true, restoredImages, updated_at: row.updated_at });
  } catch (e) {
    console.error('POST /api/data/full-restore:', e);
    res.status(500).json({ error: e.message || 'Erreur restauration' });
  }
});

app.post('/api/data/restore', async (req, res) => {
  try {
    const { positions, notes, history, settings } = req.body;
    if (!Array.isArray(positions)) {
      return res.status(400).json({ error: 'Fichier de sauvegarde invalide' });
    }
    await stmts.importUserData(DEFAULT_USER_ID, { positions, notes, history, settings });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/data/restore:', e);
    res.status(500).json({ error: e.message || 'Erreur restauration' });
  }
});

app.get('/api/data/backups', (_req, res) => {
  res.json({ backups: listBackupSnapshots() });
});

app.post('/api/data/restore-backup', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Nom de fichier requis' });
  try {
    restoreFromBackup(filename);
    const row = stmts.getData(DEFAULT_USER_ID);
    res.json({
      ok: true,
      updated_at: row.updated_at,
      wordCount: JSON.parse(row.positions).length,
      noteCount: Object.keys(JSON.parse(row.notes)).length,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => {
  try {
    res.json({ status: 'ok', storage: getStorageInfo() });
  } catch (e) {
    console.error('GET /api/health:', e);
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ─── Images ──────────────────────────────────────────────────────────────────

app.post('/api/images', (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Image manquante' });
    }
    const url = saveImageDataUri(data);
    res.json({ ok: true, url });
  } catch (e) {
    console.error('POST /api/images:', e.message);
    res.status(400).json({ error: e.message || 'Erreur image' });
  }
});

// ─── AI Generation ─────────────────────────────────────────────────────────────

app.post('/api/ai/generate', async (req, res) => {
  const { word, deepseekKey, openaiKey } = req.body;
  if (!word?.trim()) {
    return res.status(400).json({ error: 'Mot requis' });
  }

  const dsKey = deepseekKey || process.env.DEEPSEEK_API_KEY;
  const oaKey = openaiKey || process.env.OPENAI_API_KEY;

  if (!dsKey || !oaKey) {
    return res.status(400).json({
      error: 'Clés API manquantes. Configurez-les dans ⚙️ Paramètres ou dans le fichier .env du serveur.',
    });
  }

  try {
    const result = await generateNote(dsKey, oaKey, word.trim());
    if (result.image && result.image.startsWith('data:')) {
      try {
        const url = saveImageDataUri(result.image);
        result.image = url;
        result.note = [url, result.text].filter(Boolean).join('\n\n');
      } catch (imgErr) {
        console.error('Image save failed, keeping inline:', imgErr.message);
      }
    }
    res.json(result);
  } catch (e) {
    console.error('AI generation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Static files ────────────────────────────────────────────────────────────

app.use('/images', express.static(imagesDir, {
  maxAge: '365d',
  immutable: true,
}));

app.use(express.static(ROOT, { index: 'index.html' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

init();

process.on('uncaughtException', (e) => {
  console.error('uncaughtException:', e);
});

process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection:', e);
});

app.listen(PORT, HOST, () => {
  const info = getStorageInfo();
  console.log(`MindMap server → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`💾 ${info.noteCount} note(s), ${info.wordCount} mot(s), ${info.backupCount} backup(s)`);
  if (!info.persistent) {
    console.warn('⚠️  DISQUE NON PERSISTANT — passez au plan Starter + disque Render');
  }
  if (JWT_SECRET === 'change-me-in-production') {
    console.warn('⚠️  Définissez JWT_SECRET dans .env pour la production');
  }
});
