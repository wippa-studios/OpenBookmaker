'use strict';
// server.js — OpenBookmaker exchange server (Express ^4, node:sqlite).
const express = require('express');
const path = require('path');
const config = require('./lib/config');
const { openStore } = require('./lib/store');
const { seedIfNeeded } = require('./lib/seed');
const A = require('./lib/auth');
const L = require('./lib/ledger');
const M = require('./lib/match');
const SET = require('./lib/settle');
const CASH = require('./lib/cashout');
const bots = require('./lib/bots');
const drift = require('./lib/drift');
const ODDS = require('./lib/odds');

// Keep the local dashboard alive on stray async failures; log for diagnosis.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const app = express();
app.disable('x-powered-by');
// Baseline hardening headers (cheap, local-demo appropriate).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ── Origin guard FIRST, before any body parsing: mutating requests need no
// Origin (curl/local tooling) or a loopback/same-host origin (JIT/bet-agent
// pattern). Running it before express.json() means a foreign origin gets 403
// even when the body is malformed. ──────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') return next();
  } catch {}
  return res.status(403).json({ error: 'Forbidden origin' });
});

app.use(express.json({ limit: '256kb' }));

// DB + idempotent seed on first run.
const db = openStore(config.DB_PATH);
seedIfNeeded(db);
// Housekeeping: drop expired sessions at boot.
db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

// ── Session (httpOnly cookie + Bearer fallback) ───────────────────────────
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  let token = cookies.ob_session;
  const authHeader = req.headers.authorization;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  req.user = A.sessionUser(db, token);
  req.token = token;
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

function sessionCookie(token) {
  return `ob_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.SESSION_TTL_DAYS * 86400}`;
}

// ── SSE ────────────────────────────────────────────────────────────────────
const clients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId: req.user ? req.user.id : null };
  clients.add(client);
  req.on('close', () => clients.delete(client));
});

// userId === null → broadcast to everyone; otherwise private to that user.
function broadcast(event, data, userId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (userId !== null && c.userId !== userId) continue;
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const user = A.registerUser(db, { username, password });
  const token = A.createSession(db, user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.status(201).json({ user });
});

app.post('/api/auth/login', (req, res) => {
  const { user, token } = A.loginUser(db, req.body || {});
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  A.destroySession(db, req.token);
  res.setHeader('Set-Cookie', 'ob_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, available_cents: req.user.balance_cents - req.user.frozen_cents } });
});

// ── Board ──────────────────────────────────────────────────────────────────
app.get('/api/sports', (req, res) => {
  const sports = db
    .prepare(
      `SELECT s.id, s.name, s.slug,
         (SELECT COUNT(*) FROM events e WHERE e.sport_id = s.id AND e.status IN ('upcoming','live')) AS event_count
       FROM sports s ORDER BY s.sort, s.name`
    )
    .all();
  res.json({ sports });
});

app.get('/api/events', (req, res) => {
  const sportSlug = req.query.sport;
  let rows;
  if (sportSlug) {
    const sport = db.prepare('SELECT id FROM sports WHERE slug = ?').get(sportSlug);
    if (!sport) return res.status(404).json({ error: 'Unknown sport' });
    rows = db
      .prepare(
        `SELECT e.*, c.name AS competition_name, s.name AS sport_name
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
         JOIN sports s ON s.id = e.sport_id
         WHERE e.sport_id = ? AND e.status IN ('upcoming','live')
         ORDER BY e.starts_at`
      )
      .all(sport.id);
  } else {
    rows = db
      .prepare(
        `SELECT e.*, c.name AS competition_name, s.name AS sport_name
         FROM events e
         LEFT JOIN competitions c ON c.id = e.competition_id
         JOIN sports s ON s.id = e.sport_id
         WHERE e.status IN ('upcoming','live')
         ORDER BY e.starts_at`
      )
      .all();
  }
  const events = rows.map((e) => {
    const markets = db
      .prepare("SELECT id, name, status, total_matched_cents FROM markets WHERE event_id = ? AND status IN ('open','suspended') ORDER BY id")
      .all(e.id);
    return {
      id: e.id,
      name: e.name,
      sport: e.sport_name,
      competition: e.competition_name,
      starts_at: e.starts_at,
      status: e.status,
      markets: markets.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        total_matched_cents: m.total_matched_cents,
        selections: M.bookFor(db, m.id, 3),
      })),
    };
  });
  res.json({ events });
});

app.get('/api/markets/:id/book', (req, res) => {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Market not found' });
  res.json({ market: m, book: M.bookFor(db, m.id, 5) });
});

// ── Trading ────────────────────────────────────────────────────────────────
app.post('/api/orders', requireAuth, (req, res) => {
  const { selection_id, side, price, stake_cents } = req.body || {};
  const result = M.placeOrder(db, req.user, { selection_id, side, price, stake_cents });
  broadcast('book', { market_id: result.order.market_id });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.status(201).json(result);
});

app.get('/api/orders', requireAuth, (req, res) => {
  res.json({ orders: M.openOrdersFor(db, req.user.id) });
});

app.post('/api/orders/:id/cancel', requireAuth, (req, res) => {
  const order = M.cancelOrder(db, req.user, Number(req.params.id));
  broadcast('book', { market_id: order.market_id });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.json({ order });
});

app.get('/api/positions', requireAuth, (req, res) => {
  const positions = M.positionsFor(db, req.user.id).map((p) => ({
    ...p,
    cashout: CASH.cashoutQuote(db, req.user, p.market_id),
  }));
  res.json({ positions });
});

app.post('/api/markets/:id/cashout', requireAuth, (req, res) => {
  const result = CASH.cashoutMarket(db, req.user, Number(req.params.id));
  broadcast('book', { market_id: Number(req.params.id) });
  broadcast('orders', {}, req.user.id);
  broadcast('balance', {}, req.user.id);
  res.json(result);
});

// ── Wallet ─────────────────────────────────────────────────────────────────
app.get('/api/wallet', requireAuth, (req, res) => {
  res.json(L.walletView(db, req.user.id));
});

app.get('/api/settlements', requireAuth, (req, res) => {
  res.json({ settlements: SET.settledFor(db, req.user.id) });
});

app.post('/api/wallet/deposit', requireAuth, (req, res) => {
  const amount = req.body ? req.body.amount_cents : undefined;
  const result = L.deposit(db, req.user.id, amount, config.FAUCET_MAX_CENTS);
  broadcast('balance', {}, req.user.id);
  res.json(result);
});

// ── Admin (trading desk) ───────────────────────────────────────────────────
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

app.post('/api/admin/sports', requireAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  try {
    db.prepare('INSERT INTO sports (name, slug) VALUES (?, ?)').run(name, slug);
  } catch {
    return res.status(409).json({ error: 'Sport slug already exists' });
  }
  res.status(201).json({ sport: db.prepare('SELECT * FROM sports WHERE slug = ?').get(slug) });
});

app.post('/api/admin/competitions', requireAdmin, (req, res) => {
  const { sport_id, name, country } = req.body || {};
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'sport_id and name required' });
  }
  try {
    db.prepare('INSERT INTO competitions (sport_id, name, country) VALUES (?, ?, ?)').run(Number(sport_id), String(name).trim(), country || null);
  } catch {
    return res.status(400).json({ error: 'Invalid sport_id' });
  }
  const comp = db.prepare('SELECT * FROM competitions WHERE sport_id = ? AND name = ?').get(Number(sport_id), String(name).trim());
  res.status(201).json({ competition: comp });
});

app.post('/api/admin/events', requireAdmin, (req, res) => {
  const { sport_id, competition_id, name, starts_at } = req.body || {};
  if (!Number.isInteger(Number(sport_id)) || !String(name || '').trim() || !String(starts_at || '').trim()) {
    return res.status(400).json({ error: 'sport_id, name and starts_at required' });
  }
  const sportId = Number(sport_id);
  let compId = null;
  if (competition_id !== null && competition_id !== undefined && competition_id !== '') {
    compId = Number(competition_id);
    if (!Number.isInteger(compId)) return res.status(400).json({ error: 'competition_id must be an integer' });
    // A competition from a DIFFERENT sport would create inconsistent catalogue
    // data (the board groups by competition but filters by sport).
    const comp = db.prepare('SELECT sport_id FROM competitions WHERE id = ?').get(compId);
    if (!comp || comp.sport_id !== sportId) {
      return res.status(400).json({ error: 'competition_id does not belong to that sport' });
    }
  }
  try {
    db.prepare('INSERT INTO events (sport_id, competition_id, name, starts_at) VALUES (?, ?, ?, ?)').run(
      sportId,
      compId,
      String(name).trim(),
      String(starts_at).trim()
    );
  } catch {
    return res.status(400).json({ error: 'Invalid sport_id/competition_id' });
  }
  const ev = db.prepare('SELECT * FROM events WHERE sport_id = ? AND name = ? ORDER BY id DESC').get(sportId, String(name).trim());
  res.status(201).json({ event: ev });
});

app.post('/api/admin/markets', requireAdmin, (req, res) => {
  const { event_id, name } = req.body || {};
  if (!Number.isInteger(Number(event_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'event_id and name required' });
  }
  try {
    db.prepare('INSERT INTO markets (event_id, name) VALUES (?, ?)').run(Number(event_id), String(name).trim());
  } catch {
    return res.status(400).json({ error: 'Invalid event_id' });
  }
  const m = db.prepare('SELECT * FROM markets WHERE event_id = ? ORDER BY id DESC').get(Number(event_id));
  res.status(201).json({ market: m });
});

app.post('/api/admin/selections', requireAdmin, (req, res) => {
  const { market_id, name, fair_price } = req.body || {};
  if (!Number.isInteger(Number(market_id)) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'market_id and name required' });
  }
  let fair = null;
  if (fair_price !== undefined && fair_price !== null) {
    fair = ODDS.snapToTick(Number(fair_price));
  }
  try {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(Number(market_id), String(name).trim(), fair);
  } catch {
    return res.status(400).json({ error: 'Invalid market_id' });
  }
  const sel = db.prepare('SELECT * FROM selections WHERE market_id = ? AND name = ?').get(Number(market_id), String(name).trim());
  // A market created at runtime has no ladders until something quotes it —
  // quote immediately so new markets are tradeable (the bot's own two sides
  // never cross, so a single runner is safe to quote).
  if (config.BOT_ENABLED) {
    try {
      bots.quoteMarket(db, Number(market_id));
    } catch (e) {
      console.error('[bots] quote-after-create failed:', e.message);
    }
  }
  res.status(201).json({ selection: sel });
});

app.patch('/api/admin/markets/:id', requireAdmin, (req, res) => {
  const status = (req.body || {}).status;
  if (!['open', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be open or suspended' });
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Market not found' });
  if (m.status === 'settled') return res.status(409).json({ error: 'Market is settled' });
  db.prepare('UPDATE markets SET status = ? WHERE id = ?').run(status, m.id);
  broadcast('book', { market_id: m.id });
  res.json({ market: db.prepare('SELECT * FROM markets WHERE id = ?').get(m.id) });
});

app.post('/api/admin/markets/:id/settle', requireAdmin, (req, res) => {
  const body = req.body || {};
  // Pass the caller's values through UNCHANGED: lib/settle.js validates
  // strictly (a string "false" must not void a market, a boolean must not
  // become selection id 1). No coercion happens here on purpose.
  const result = SET.settleMarket(db, Number(req.params.id), {
    winner_selection_id: body.winner_selection_id === undefined ? null : body.winner_selection_id,
    void: body.void === undefined ? false : body.void,
  });
  broadcast('book', { market_id: Number(req.params.id) });
  broadcast('settlement', { market_id: Number(req.params.id) });
  for (const u of result.per_user) {
    broadcast('balance', {}, u.user_id);
    broadcast('orders', {}, u.user_id);
  }
  res.json(result);
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const markets = db
    .prepare(
      `SELECT m.id, m.name, m.status, m.total_matched_cents, e.name AS event_name,
         (SELECT COUNT(*) FROM orders o WHERE o.market_id = m.id AND o.status = 'open') AS open_orders
       FROM markets m JOIN events e ON e.id = m.event_id
       ORDER BY m.id DESC LIMIT 200`
    )
    .all();
  res.json({ markets });
});

// Competitions for a sport — the admin desk's create form needs the list.
app.get('/api/admin/competitions', requireAdmin, (req, res) => {
  const sportId = Number(req.query.sport_id);
  if (!Number.isInteger(sportId)) return res.status(400).json({ error: 'sport_id required' });
  const competitions = db
    .prepare('SELECT id, name, country FROM competitions WHERE sport_id = ? ORDER BY name')
    .all(sportId);
  res.json({ competitions });
});

// ── Static frontend + error handler ────────────────────────────────────────
// Unknown API paths must answer JSON, not Express's HTML 404 page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint' });
});

app.use(express.static(path.join(__dirname, 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

function main() {
  if (config.BOT_ENABLED) {
    try {
      bots.quoteAllMarkets(db);
      console.log('[bots] liquidity quoted on all open markets');
    } catch (e) {
      console.error('[bots]', e.message);
    }
  }
  if (config.DRIFT_ENABLED) {
    drift.startDrift(db, { intervalMs: config.DRIFT_INTERVAL_MS, broadcast });
    console.log('[drift] on');
  }
  app.listen(config.PORT, config.HOST, () => {
    console.log(`OpenBookmaker exchange on http://${config.HOST}:${config.PORT} (paper money only)`);
  });
}

if (require.main === module) main();

module.exports = { app, db, broadcast };
