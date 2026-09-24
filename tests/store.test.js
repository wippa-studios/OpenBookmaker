// store.test.js — schema, constraints and connection behaviour.
// Run: node tests/store.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

const TABLES = [
  'users', 'sessions', 'sports', 'competitions', 'events', 'markets', 'selections',
  'orders', 'matches', 'price_history', 'settlements', 'transactions', 'settings',
];

// D1: every table from the domain spec exists, and opening twice is safe.
check('D1 schema is complete and idempotent', () => {
  const db = openStore(':memory:');
  for (const t of TABLES) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row, `table ${t} exists`);
  }
  openStore(':memory:').exec('SELECT 1'); // no throw on a fresh open
});

// D2: foreign keys are enforced (a match cannot point at a missing order).
check('D2 foreign keys enforced', () => {
  const db = openStore(':memory:');
  assert.throws(() => {
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('t', 999, datetime('now'))").run();
  }, /FOREIGN KEY/);
  assert.throws(() => {
    db.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents) VALUES (999,999,999,'back',2.0,100)").run();
  }, /FOREIGN KEY/);
});

// D3: the money invariants are enforced by the DATABASE, not only by service
// code: integer cents, non-negative, matched <= stake, price on the ladder.
check('D3 money CHECK constraints', () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (1,'A',2.0)").run();
  const mkUser = () =>
    db.prepare("INSERT INTO users (username, pass_hash, balance_cents) VALUES (?, 'x', 0)").run('u' + Math.random().toString(36).slice(2)).lastInsertRowid;

  const u = mkUser();
  assert.throws(() => db.prepare('UPDATE users SET balance_cents = -1 WHERE id=?').run(u), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE users SET frozen_cents = -5 WHERE id=?').run(u), /CHECK constraint failed/);

  const ins = db.prepare(
    "INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents) VALUES (?,1,1,'back',2.0,1000,0)"
  );
  const oid = ins.run(u).lastInsertRowid;
  assert.throws(() => db.prepare('UPDATE orders SET matched_cents = 1001 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE orders SET price = 0.5 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE orders SET price = 5000 WHERE id=?').run(oid), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE orders SET side = 'sideways' WHERE id=?").run(oid), /CHECK constraint failed/);
  assert.throws(
    () => db.prepare("INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents) VALUES (?,1,1,'lay',2.0,0)").run(u),
    /CHECK constraint failed/
  );
  // a valid update still works
  db.prepare('UPDATE orders SET matched_cents = 1000 WHERE id=?').run(oid);
  assert.strictEqual(db.prepare('SELECT matched_cents m FROM orders WHERE id=?').get(oid).m, 1000);
});

// D4: settlement rows cannot record a negative commission.
check('D4 settlement constraints', () => {
  const db = openStore(':memory:');
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
  const u = db.prepare("INSERT INTO users (username, pass_hash) VALUES ('u','x')").run().lastInsertRowid;
  assert.throws(
    () => db.prepare('INSERT INTO settlements (market_id, user_id, credit_cents, commission_cents, pnl_cents) VALUES (1,?,0,-1,0)').run(u),
    /CHECK constraint failed/
  );
});

console.log(`\nstore.test.js: ${passed} checks passed`);
