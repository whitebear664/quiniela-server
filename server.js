const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ── In-memory store ──────────────────────────────────────────────
let users    = {};   // { id: { password, name } }
let sessions = {};   // { token: userId }
let sheets   = {};   // { sheetId: { name, games:[{id,home,away}], open, results:{gameId:{home,away}} } }
let guesses  = {};   // { sheetId: { userId: { gameId: {home,away}, submitted } } }
let scores   = {};   // { userId: totalPoints }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ── Helpers ───────────────────────────────────────────────────────
function token() { return crypto.randomBytes(16).toString('hex'); }

function calcPoints(guess, result) {
  if (!guess || !result) return 0;
  const gH = parseInt(guess.home), gA = parseInt(guess.away);
  const rH = parseInt(result.home), rA = parseInt(result.away);
  if (gH === rH && gA === rA) return 3;
  const gWin = gH > gA ? 'H' : gH < gA ? 'A' : 'D';
  const rWin = rH > rA ? 'H' : rH < rA ? 'A' : 'D';
  if (gWin === rWin) return 1;
  return 0;
}

function recalcAll() {
  scores = {};
  for (const [sheetId, sheet] of Object.entries(sheets)) {
    if (!sheet.results) continue;
    for (const [userId, userGuesses] of Object.entries(guesses[sheetId] || {})) {
      if (!userGuesses.submitted) continue;
      if (!scores[userId]) scores[userId] = 0;
      for (const [gameId, result] of Object.entries(sheet.results)) {
        scores[userId] += calcPoints(userGuesses[gameId], result);
      }
    }
  }
}

function getLeaderboard() {
  return Object.entries(scores)
    .map(([uid, pts]) => ({ id: uid, name: users[uid]?.name || uid, points: pts }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
}

// ── Auth ──────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const t = token();
  sessions[t] = '__admin__';
  res.json({ token: t });
});

app.post('/login', (req, res) => {
  const { id, password } = req.body;
  const user = users[id];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Wrong ID or password' });
  const t = token();
  sessions[t] = id;
  res.json({ token: t, name: user.name });
});

function authUser(req, res) {
  const t = req.headers['x-token'];
  const uid = sessions[t];
  if (!uid || uid === '__admin__') { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return uid;
}

function authAdmin(req, res) {
  const t = req.headers['x-token'];
  if (sessions[t] !== '__admin__') { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// ── Public ────────────────────────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// ── User routes ───────────────────────────────────────────────────
app.get('/sheets', (req, res) => {
  const uid = authUser(req, res); if (!uid) return;
  const list = Object.entries(sheets).map(([id, s]) => ({
    id, name: s.name, open: s.open, gameCount: s.games.length,
    submitted: !!(guesses[id]?.[uid]?.submitted),
    hasResults: Object.keys(s.results || {}).length > 0
  }));
  res.json(list);
});

app.get('/sheet/:id', (req, res) => {
  const uid = authUser(req, res); if (!uid) return;
  const sheet = sheets[req.params.id];
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const myGuess = guesses[req.params.id]?.[uid] || {};
  res.json({ ...sheet, myGuess });
});

app.post('/sheet/:id/guess', (req, res) => {
  const uid = authUser(req, res); if (!uid) return;
  const sid = req.params.id;
  const sheet = sheets[sid];
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  if (!sheet.open) return res.status(400).json({ error: 'Sheet is closed' });
  if (guesses[sid]?.[uid]?.submitted) return res.status(400).json({ error: 'Already submitted' });
  const { gameGuesses } = req.body;
  if (!guesses[sid]) guesses[sid] = {};
  guesses[sid][uid] = { ...gameGuesses, submitted: true };
  recalcAll();
  res.json({ ok: true });
});

app.get('/sheet/:id/results', (req, res) => {
  const uid = authUser(req, res); if (!uid) return;
  const sid = req.params.id;
  const sheet = sheets[sid];
  if (!sheet || !sheet.results) return res.status(404).json({ error: 'No results yet' });
  const myGuess = guesses[sid]?.[uid] || {};
  const breakdown = sheet.games.map(g => {
    const result = sheet.results[g.id];
    const guess = myGuess[g.id];
    const pts = calcPoints(guess, result);
    return { game: g, guess, result, points: pts };
  });
  const total = breakdown.reduce((s, r) => s + r.points, 0);
  res.json({ breakdown, total });
});

// ── Admin routes ──────────────────────────────────────────────────
app.get('/admin/users', (req, res) => {
  if (!authAdmin(req, res)) return;
  res.json(Object.entries(users).map(([id, u]) => ({ id, name: u.name })));
});

app.post('/admin/user', (req, res) => {
  if (!authAdmin(req, res)) return;
  const { id, password, name } = req.body;
  if (users[id]) return res.status(400).json({ error: 'ID already exists' });
  users[id] = { password, name };
  res.json({ ok: true });
});

app.delete('/admin/user/:id', (req, res) => {
  if (!authAdmin(req, res)) return;
  delete users[req.params.id];
  res.json({ ok: true });
});

app.get('/admin/sheets', (req, res) => {
  if (!authAdmin(req, res)) return;
  res.json(Object.entries(sheets).map(([id, s]) => ({
    id, name: s.name, open: s.open,
    gameCount: s.games.length,
    hasResults: Object.keys(s.results || {}).length > 0
  })));
});

app.post('/admin/sheet', (req, res) => {
  if (!authAdmin(req, res)) return;
  const { name, games } = req.body;
  const id = 'sheet_' + Date.now();
  sheets[id] = { name, games, open: true, results: {} };
  guesses[id] = {};
  res.json({ id });
});

app.post('/admin/sheet/:id/close', (req, res) => {
  if (!authAdmin(req, res)) return;
  if (sheets[req.params.id]) sheets[req.params.id].open = false;
  res.json({ ok: true });
});

app.post('/admin/sheet/:id/open', (req, res) => {
  if (!authAdmin(req, res)) return;
  if (sheets[req.params.id]) sheets[req.params.id].open = true;
  res.json({ ok: true });
});

app.delete('/admin/sheet/:id', (req, res) => {
  if (!authAdmin(req, res)) return;
  delete sheets[req.params.id];
  delete guesses[req.params.id];
  recalcAll();
  res.json({ ok: true });
});

app.post('/admin/sheet/:id/results', (req, res) => {
  if (!authAdmin(req, res)) return;
  const { results } = req.body; // { gameId: {home, away} }
  if (!sheets[req.params.id]) return res.status(404).json({ error: 'Not found' });
  sheets[req.params.id].results = results;
  recalcAll();
  res.json({ ok: true });
});

app.get('/admin/sheet/:id/guesses', (req, res) => {
  if (!authAdmin(req, res)) return;
  const sid = req.params.id;
  const sheet = sheets[sid];
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const out = Object.entries(guesses[sid] || {}).map(([uid, g]) => ({
    userId: uid, name: users[uid]?.name || uid,
    submitted: g.submitted,
    guesses: sheet.games.reduce((acc, game) => {
      acc[game.id] = g[game.id] || null; return acc;
    }, {})
  }));
  res.json({ sheet, participants: out });
});

app.delete('/admin/sheet/:id/guess/:userId', (req, res) => {
  if (!authAdmin(req, res)) return;
  const { id, userId } = req.params;
  if (guesses[id]) delete guesses[id][userId];
  recalcAll();
  res.json({ ok: true });
});

app.get('/admin/leaderboard', (req, res) => {
  if (!authAdmin(req, res)) return;
  const all = Object.entries(scores)
    .map(([uid, pts]) => ({ id: uid, name: users[uid]?.name || uid, points: pts }))
    .sort((a, b) => b.points - a.points);
  res.json(all);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiniela server running on port ${PORT}`));

// ── Public standings (full leaderboard with picks) ────────────────
app.get('/standings', (req, res) => {
  const allUsers = Object.entries(users).map(([uid, u]) => {
    const pts = scores[uid] || 0;
    const userSheets = {};
    for (const [sheetId, sheet] of Object.entries(sheets)) {
      const g = guesses[sheetId]?.[uid];
      if (!g || !g.submitted) continue;
      userSheets[sheetId] = {
        sheetName: sheet.name,
        games: sheet.games.map(game => ({
          home: game.home, away: game.away,
          guess: g[game.id] || null,
          result: sheet.results?.[game.id] || null
        }))
      };
    }
    return { id: uid, name: u.name, points: pts, sheets: userSheets };
  }).sort((a, b) => b.points - a.points);
  res.json(allUsers);
});
