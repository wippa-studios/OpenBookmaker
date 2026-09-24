// seed.test.js — demo seeding is idempotent, and board hygiene ages fixtures.
// Run: node tests/seed.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const { seed, seedIfNeeded, rollForwardEvents } = require('../lib/seed');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

// S1: first run seeds the catalogue and the demo accounts; second run is a
// no-op (guarded by the 'seeded' settings key).
check('S1 seed is idempotent', () => {
  const db = openStore(':memory:');
  assert.strictEqual(seedIfNeeded(db), true);
  const first = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.strictEqual(seedIfNeeded(db), false);
  const second = ['sports', 'competitions', 'events', 'markets', 'selections', 'users'].map((t) => count(db, t));
  assert.deepStrictEqual(second, first);
  assert.ok(count(db, 'events') >= 8, 'at least 8 events');
  assert.ok(count(db, 'selections') >= 20, 'at least 20 runners');
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='seeded'").get().value, '1');
});

// S2: the demo accounts exist with the documented roles and balances.
check('S2 demo accounts', () => {
  const db = openStore(':memory:');
  seed(db);
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  const demo = db.prepare("SELECT * FROM users WHERE username='demo'").get();
  const bot = db.prepare("SELECT * FROM users WHERE username='MarketMakers'").get();
  assert.strictEqual(admin.is_admin, 1);
  assert.strictEqual(demo.is_admin, 0);
  assert.strictEqual(bot.is_bot, 1);
  assert.ok(A.loginUser(db, { username: 'admin', password: 'admin123' }).token);
  assert.ok(A.loginUser(db, { username: 'demo', password: 'demo123' }).token);
  assert.throws(() => A.loginUser(db, { username: 'demo', password: 'wrong' }), (e) => e.status === 401);
  // bots hold the deepest book
  assert.ok(bot.balance_cents > admin.balance_cents, 'bot bank is the largest');
});

// S3: every seeded selection carries a fair price inside the ladder, so the
// bot can quote it (a fair-priceless runner gets no ladder by design).
check('S3 seeded fair prices are ladder-valid', () => {
  const { validTick } = require('../lib/odds');
  const db = openStore(':memory:');
  seed(db);
  const rows = db.prepare('SELECT name, fair_price FROM selections').all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(validTick(r.fair_price), `${r.name}: ${r.fair_price} is a ladder tick`);
  }
});

// S4: past-due fixtures become 'live' so a long-running demo keeps a board;
// future events and completed events are left alone.
check('S4 roll forward past-due events', () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  const add = (name, starts, status) =>
    db
      .prepare('INSERT INTO events (sport_id, name, starts_at, status) VALUES (1, ?, ?, ?)')
      .run(name, starts, status);
  add('past-upcoming', '2020-01-01 12:00:00', 'upcoming');
  add('soon-upcoming', '2099-01-01 12:00:00', 'upcoming');
  add('past-completed', '2020-01-01 12:00:00', 'completed');
  assert.strictEqual(rollForwardEvents(db), 1);
  const status = (n) => db.prepare('SELECT status s FROM events WHERE name=?').get(n).s;
  assert.strictEqual(status('past-upcoming'), 'live');
  assert.strictEqual(status('soon-upcoming'), 'upcoming');
  assert.strictEqual(status('past-completed'), 'completed');
  // idempotent: nothing left to roll
  assert.strictEqual(rollForwardEvents(db), 0);
});

console.log(`\nseed.test.js: ${passed} checks passed`);
