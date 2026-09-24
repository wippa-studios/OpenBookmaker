// tx.test.js — transaction discipline (lib/tx.js) and money-path atomicity.
// Run: node tests/tx.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const L = require('../lib/ledger');
const M = require('../lib/match');
const { transaction, inTransaction } = require('../lib/tx');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

function fresh() {
  const db = openStore(':memory:');
  const u = A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 100000 });
  return { db, u };
}

// X1: a committed transaction persists; a failed one leaves nothing behind.
check('X1 commit and rollback', () => {
  const { db } = fresh();
  transaction(db, () => db.prepare("UPDATE users SET balance_cents = 7").run());
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users').get().b, 7);
  assert.strictEqual(inTransaction(), false);
  assert.throws(() => {
    transaction(db, () => {
      db.prepare('UPDATE users SET balance_cents = 99').run();
      throw new Error('boom');
    });
  }, /boom/);
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users').get().b, 7); // rolled back
  assert.strictEqual(inTransaction(), false);
});

// X2: nesting uses SAVEPOINTs (SQLite forbids a nested BEGIN) and the inner
// failure rolls back only the inner work.
check('X2 nested savepoints', () => {
  const { db, u } = fresh();
  transaction(db, () => {
    db.prepare('UPDATE users SET balance_cents = 50').run();
    assert.strictEqual(inTransaction(), true);
    try {
      transaction(db, () => {
        db.prepare('UPDATE users SET balance_cents = 60').run();
        throw new Error('inner');
      });
    } catch (e) {
      assert.strictEqual(e.message, 'inner');
    }
    // outer work survives, inner work is gone
    assert.strictEqual(db.prepare('SELECT balance_cents b FROM users').get().b, 50);
  });
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users').get().b, 50);
});

// X3: depth always unwinds, even when the body throws a non-Error.
check('X3 depth unwinds on throw', () => {
  const { db } = fresh();
  assert.throws(() => transaction(db, () => { throw 'a string'; }));
  assert.strictEqual(inTransaction(), false);
  // and the connection is still usable afterwards
  transaction(db, () => db.prepare('UPDATE users SET balance_cents = 3').run());
  assert.strictEqual(db.prepare('SELECT balance_cents b FROM users').get().b, 3);
});

// X4: placeOrderTx refuses to run outside a transaction — the whole point of
// exporting it separately is that the CALLER owns the rollback.
check('X4 placeOrderTx requires a transaction', () => {
  const { db, u } = fresh();
  db.prepare("INSERT INTO sports (name, slug) VALUES ('Football','football')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now','+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'Match Odds')").run();
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (1,'A',2.0)").run();
  const sel = db.prepare('SELECT id FROM selections').get().id;
  assert.throws(
    () => M.placeOrderTx(db, u, { selection_id: sel, side: 'back', price: 2.0, stake_cents: 10000 }),
    /must be called inside a transaction/
  );
  // nothing was written
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
  assert.strictEqual(L.walletView(db, u.id).frozen_cents, 0);
});

// X5: a ledger op called standalone is still atomic (it opens its own
// transaction), and two of them compose into one.
check('X5 standalone and composed ledger ops', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 1000);           // standalone
  assert.deepStrictEqual([L.availableOf(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))], [99000]);
  L.escrow(db, u.id, 2000);
  L.release(db, u.id, 500);
  const v = L.walletView(db, u.id);
  assert.deepStrictEqual({ b: v.balance_cents, f: v.frozen_cents, a: v.available_cents }, { b: 100000, f: 2500, a: 97500 });
});

// X6: a failed service op leaves the wallet AND the order book untouched.
check('X6 failed place is all-or-nothing', () => {
  const { db } = fresh();
  const mk = (n, bal) => A.registerUser(db, { username: n, password: 'secret1', balance_cents: bal });
  db.prepare("INSERT INTO sports (name, slug) VALUES ('F','f')").run();
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (1,'E',datetime('now','+2 hours'))").run();
  db.prepare("INSERT INTO markets (event_id, name) VALUES (1,'M')").run();
  db.prepare("INSERT INTO selections (market_id, name, fair_price) VALUES (1,'A',2.0)").run();
  const sel = db.prepare('SELECT id FROM selections').get().id;
  const poor = mk('poor', 500);
  // stake escrow (2000) exceeds the balance (500) -> the whole op must abort
  assert.throws(() => M.placeOrder(db, poor, { selection_id: sel, side: 'back', price: 2.0, stake_cents: 2000 }), /Insufficient/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0);
  const u = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id=?').get(poor.id);
  assert.deepStrictEqual({ b: u.b, f: u.f }, { b: 500, f: 0 });
  assert.strictEqual(inTransaction(), false);
});

console.log(`\ntx.test.js: ${passed} checks passed`);
