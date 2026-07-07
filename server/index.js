require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { stmts, getStorageInfo, dataDir } = require('./db');
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
app.use(express.json({ limit: '10mb' }));

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
  const userId = result.lastInsertRowid;

  const token = signToken(userId, normalized);
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

app.get('/api/data', authMiddleware, (req, res) => {
  const row = stmts.getData(req.user.userId);
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
    positions: JSON.parse(row.positions),
    notes: JSON.parse(row.notes),
    history: JSON.parse(row.history),
    settings: JSON.parse(row.settings),
    updated_at: row.updated_at,
  });
});

app.put('/api/data', authMiddleware, (req, res) => {
  const { positions, notes, history, settings } = req.body;
  if (!Array.isArray(positions) || typeof notes !== 'object') {
    return res.status(400).json({ error: 'Données invalides' });
  }

  stmts.upsertData(
    req.user.userId,
    JSON.stringify(positions),
    JSON.stringify(notes || {}),
    JSON.stringify(history || []),
    JSON.stringify(settings || {}),
  );

  const row = stmts.getData(req.user.userId);
  res.json({ ok: true, updated_at: row.updated_at });
});

app.get('/api/data/backup', authMiddleware, (req, res) => {
  const data = stmts.exportUserData(req.user.userId);
  if (!data) return res.status(404).json({ error: 'Aucune donnée' });
  res.setHeader('Content-Disposition', `attachment; filename="mindmap-backup-${Date.now()}.json"`);
  res.json(data);
});

app.post('/api/data/restore', authMiddleware, (req, res) => {
  const { positions, notes, history, settings } = req.body;
  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: 'Fichier de sauvegarde invalide' });
  }
  stmts.importUserData(req.user.userId, { positions, notes, history, settings });
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', storage: getStorageInfo() });
});

// ─── AI Generation (proxy — évite CORS navigateur) ───────────────────────────

app.post('/api/ai/generate', authMiddleware, async (req, res) => {
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
    res.json(result);
  } catch (e) {
    console.error('AI generation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Static files ────────────────────────────────────────────────────────────

app.use(express.static(ROOT, { index: 'index.html' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, HOST, () => {
  const info = getStorageInfo();
  console.log(`MindMap server → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`📁 Données stockées dans : ${dataDir}`);
  console.log(`💾 Sauvegardes auto : ${info.backupCount} fichier(s)`);
  if (JWT_SECRET === 'change-me-in-production') {
    console.warn('⚠️  Définissez JWT_SECRET dans .env pour la production');
  }
});
