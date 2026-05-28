const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ── Init tables ───────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      games JSONB NOT NULL DEFAULT '[]',
      open BOOLEAN DEFAULT TRUE,
      results JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS guesses (
      sheet_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      submitted BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (sheet_id, user_id)
    );
  `);
  console.log('DB ready');
}

// ── Helpers ───────────────────────────────────────────────────────
function token() { return crypto.randomBytes(16).toString('hex'); }

function calcPoints(guess, result) {
  if (!guess || !result) return 0;
  const gH = parseInt(guess.home), gA = parseInt(guess.away);
  const rH = parseInt(result.home), rA = parseInt(result.away);
  if (gH === rH && gA === rA) return 3;
  const gW = gH > gA ? 'H' : gH < gA ? 'A' : 'D';
  const rW = rH > rA ? 'H' : rH < rA ? 'A' : 'D';
  return gW === rW ? 1 : 0;
}

async function getUserScore(userId) {
  const sheets = await pool.query('SELECT id, games, results FROM sheets');
  let total = 0;
  for (const sheet of sheets.rows) {
    if (!sheet.results || !Object.keys(sheet.results).length) continue;
    const g = await pool.query('SELECT data FROM guesses WHERE sheet_id=$1 AND user_id=$2 AND submitted=TRUE', [sheet.id, userId]);
    if (!g.rows.length) continue;
    const guessData = g.rows[0].data;
    for (const [gameId, result] of Object.entries(sheet.results)) {
      total += calcPoints(guessData[gameId], result);
    }
  }
  return total;
}

async function getLeaderboard(limit = 3) {
  const users = await pool.query('SELECT id, name FROM users');
  const scores = await Promise.all(users.rows.map(async u => ({
    id: u.id, name: u.name, points: await getUserScore(u.id)
  })));
  return scores.sort((a, b) => b.points - a.points).slice(0, limit);
}

// ── Auth middleware ───────────────────────────────────────────────
async function authUser(req, res) {
  const t = req.headers['x-token'];
  const r = await pool.query('SELECT user_id FROM sessions WHERE token=$1', [t]);
  if (!r.rows.length || r.rows[0].user_id === '__admin__') { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return r.rows[0].user_id;
}

async function authAdmin(req, res) {
  const t = req.headers['x-token'];
  const r = await pool.query('SELECT user_id FROM sessions WHERE token=$1', [t]);
  if (!r.rows.length || r.rows[0].user_id !== '__admin__') { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// ── Auth routes ───────────────────────────────────────────────────
app.post('/admin/login', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const t = token();
  await pool.query('INSERT INTO sessions(token, user_id) VALUES($1,$2)', [t, '__admin__']);
  res.json({ token: t });
});

app.post('/login', async (req, res) => {
  const { id, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  if (!r.rows.length || r.rows[0].password !== password) return res.status(401).json({ error: 'Wrong ID or password' });
  const t = token();
  await pool.query('INSERT INTO sessions(token, user_id) VALUES($1,$2)', [t, id]);
  res.json({ token: t, name: r.rows[0].name });
});

// ── Public routes ─────────────────────────────────────────────────
app.get('/leaderboard', async (req, res) => {
  res.json(await getLeaderboard(3));
});

app.get('/standings', async (req, res) => {
  const users = await pool.query('SELECT id, name FROM users');
  const result = await Promise.all(users.rows.map(async u => {
    const pts = await getUserScore(u.id);
    const sheets = await pool.query('SELECT id, name, games, results FROM sheets');
    const userSheets = {};
    for (const sheet of sheets.rows) {
      const g = await pool.query('SELECT data FROM guesses WHERE sheet_id=$1 AND user_id=$2 AND submitted=TRUE', [sheet.id, u.id]);
      if (!g.rows.length) continue;
      const guessData = g.rows[0].data;
      userSheets[sheet.id] = {
        sheetName: sheet.name,
        games: sheet.games.map(game => ({
          home: game.home, away: game.away,
          guess: guessData[game.id] || null,
          result: sheet.results?.[game.id] || null
        }))
      };
    }
    return { id: u.id, name: u.name, points: pts, sheets: userSheets };
  }));
  res.json(result.sort((a, b) => b.points - a.points));
});

// ── User routes ───────────────────────────────────────────────────
app.get('/sheets', async (req, res) => {
  const uid = await authUser(req, res); if (!uid) return;
  const sheets = await pool.query('SELECT * FROM sheets ORDER BY id');
  const result = await Promise.all(sheets.rows.map(async s => {
    const g = await pool.query('SELECT submitted FROM guesses WHERE sheet_id=$1 AND user_id=$2', [s.id, uid]);
    return {
      id: s.id, name: s.name, open: s.open,
      gameCount: s.games.length,
      submitted: g.rows.length > 0 && g.rows[0].submitted,
      hasResults: s.results && Object.keys(s.results).length > 0
    };
  }));
  res.json(result);
});

app.get('/sheet/:id', async (req, res) => {
  const uid = await authUser(req, res); if (!uid) return;
  const r = await pool.query('SELECT * FROM sheets WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const sheet = r.rows[0];
  const g = await pool.query('SELECT data FROM guesses WHERE sheet_id=$1 AND user_id=$2', [req.params.id, uid]);
  res.json({ ...sheet, myGuess: g.rows[0]?.data || {} });
});

app.post('/sheet/:id/guess', async (req, res) => {
  const uid = await authUser(req, res); if (!uid) return;
  const sid = req.params.id;
  const r = await pool.query('SELECT open FROM sheets WHERE id=$1', [sid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  if (!r.rows[0].open) return res.status(400).json({ error: 'Sheet is closed' });
  const existing = await pool.query('SELECT submitted FROM guesses WHERE sheet_id=$1 AND user_id=$2', [sid, uid]);
  if (existing.rows.length && existing.rows[0].submitted) return res.status(400).json({ error: 'Already submitted' });
  await pool.query(
    'INSERT INTO guesses(sheet_id, user_id, data, submitted) VALUES($1,$2,$3,TRUE) ON CONFLICT(sheet_id,user_id) DO UPDATE SET data=$3, submitted=TRUE',
    [sid, uid, JSON.stringify(req.body.gameGuesses)]
  );
  res.json({ ok: true });
});

app.get('/sheet/:id/results', async (req, res) => {
  const uid = await authUser(req, res); if (!uid) return;
  const sid = req.params.id;
  const r = await pool.query('SELECT * FROM sheets WHERE id=$1', [sid]);
  if (!r.rows.length || !Object.keys(r.rows[0].results || {}).length) return res.status(404).json({ error: 'No results yet' });
  const sheet = r.rows[0];
  const g = await pool.query('SELECT data FROM guesses WHERE sheet_id=$1 AND user_id=$2', [sid, uid]);
  const myGuess = g.rows[0]?.data || {};
  const breakdown = sheet.games.map(game => {
    const result = sheet.results[game.id];
    const guess = myGuess[game.id];
    return { game, guess, result, points: calcPoints(guess, result) };
  });
  res.json({ breakdown, total: breakdown.reduce((s, r) => s + r.points, 0) });
});

// ── Admin routes ──────────────────────────────────────────────────
app.get('/admin/users', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const r = await pool.query('SELECT id, name FROM users ORDER BY name');
  res.json(r.rows);
});

app.post('/admin/user', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const { id, password, name } = req.body;
  try {
    await pool.query('INSERT INTO users(id, name, password) VALUES($1,$2,$3)', [id, name, password]);
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: 'ID already exists' }); }
});

app.delete('/admin/user/:id', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/admin/sheets', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const r = await pool.query('SELECT * FROM sheets ORDER BY id');
  res.json(r.rows.map(s => ({
    id: s.id, name: s.name, open: s.open,
    gameCount: s.games.length,
    hasResults: s.results && Object.keys(s.results).length > 0
  })));
});

app.post('/admin/sheet', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const { name, games } = req.body;
  const id = 'sheet_' + Date.now();
  await pool.query('INSERT INTO sheets(id, name, games, open, results) VALUES($1,$2,$3,TRUE,$4)',
    [id, name, JSON.stringify(games), '{}']);
  res.json({ id });
});

app.post('/admin/sheet/:id/close', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('UPDATE sheets SET open=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/admin/sheet/:id/open', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('UPDATE sheets SET open=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/admin/sheet/:id', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('DELETE FROM guesses WHERE sheet_id=$1', [req.params.id]);
  await pool.query('DELETE FROM sheets WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/admin/sheet/:id/results', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('UPDATE sheets SET results=$1 WHERE id=$2', [JSON.stringify(req.body.results), req.params.id]);
  res.json({ ok: true });
});

app.get('/admin/sheet/:id/guesses', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const sid = req.params.id;
  const sheet = await pool.query('SELECT * FROM sheets WHERE id=$1', [sid]);
  if (!sheet.rows.length) return res.status(404).json({ error: 'Not found' });
  const s = sheet.rows[0];
  const allGuesses = await pool.query('SELECT g.user_id, g.data, g.submitted, u.name FROM guesses g JOIN users u ON u.id=g.user_id WHERE g.sheet_id=$1', [sid]);
  const participants = allGuesses.rows.map(g => ({
    userId: g.user_id, name: g.name, submitted: g.submitted,
    guesses: s.games.reduce((acc, game) => { acc[game.id] = g.data[game.id] || null; return acc; }, {})
  }));
  res.json({ sheet: s, participants });
});

app.delete('/admin/sheet/:id/guess/:userId', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  await pool.query('DELETE FROM guesses WHERE sheet_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  res.json({ ok: true });
});

app.get('/admin/leaderboard', async (req, res) => {
  if (!await authAdmin(req, res)) return;
  const users = await pool.query('SELECT id, name FROM users');
  const scores = await Promise.all(users.rows.map(async u => ({
    id: u.id, name: u.name, points: await getUserScore(u.id)
  })));
  res.json(scores.sort((a, b) => b.points - a.points));
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`)));
