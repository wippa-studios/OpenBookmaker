// ledger.test.js — wallet integrity: deposits, escrow/release, settlement.
// Run: node tests/ledger.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const L = require('../lib/ledger');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

function fresh() {
  const db = openStore(':memory:');
  const u = A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 1000 });
  return { db, u };
}

const balanceOf = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f }; // node:sqlite rows are null-prototype — spread to plain
};

// L1: deposits — cap + type validation.
check('L1 deposit', () => {
  const { db, u } = fresh();
  L.deposit(db, u.id, 5000, 100000);
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 6000, f: 0 });
  assert.throws(() => L.deposit(db, u.id, 100001, 100000), (e) => e.status === 400);
  assert.throws(() => L.deposit(db, u.id, 0, 100000), (e) => e.status === 400);
  assert.throws(() => L.deposit(db, u.id, -5, 100000), (e) => e.status === 400);
  assert.throws(() => L.deposit(db, u.id, 500.5, 100000), (e) => e.status === 400);
  assert.throws(() => L.deposit(db, u.id, '500', 100000), (e) => e.status === 400);
});

// L2: escrow — freezes, refuses to over-commit.
check('L2 escrow', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 1000);
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 1000 });
  assert.throws(() => L.escrow(db, u.id, 1), (e) => e.status === 400); // available 0
  assert.throws(() => L.escrow(db, u.id, 100.5), (e) => e.status === 400);
  const tx = db.prepare("SELECT * FROM transactions WHERE type = 'escrow'").get();
  assert.strictEqual(tx.balance_after, 1000);
  assert.strictEqual(tx.frozen_after, 1000);
});

// L3: release — unfreezes, never below zero.
check('L3 release', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 1000);
  L.release(db, u.id, 400);
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 600 });
  assert.throws(() => L.release(db, u.id, 601), (e) => e.status === 400);
  L.release(db, u.id, 600);
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 0 });
});

// L4: settlement WIN — back match, stake 200 @ 1.75 escrowed.
// profit = 200*(1.75-1) = 150; commission = round(150*0.025) = 4.
// balance 1000 + 150 - 4 = 1146, frozen 0.
check('L4 settle win (with commission)', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 200);
  L.settleUser(db, u.id, { balanceDelta: 150, frozenRelease: 200, commissionCents: 4 });
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1146, f: 0 });
  const settle = db.prepare("SELECT amount_cents FROM transactions WHERE type = 'settle'").get();
  const comm = db.prepare("SELECT amount_cents FROM transactions WHERE type = 'commission'").get();
  assert.strictEqual(settle.amount_cents, 150);
  assert.strictEqual(comm.amount_cents, 4);
});

// L5: settlement LOSS — no commission, negative settle row.
check('L5 settle loss', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 200);
  L.settleUser(db, u.id, { balanceDelta: -200, frozenRelease: 200 });
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 800, f: 0 });
  const settle = db.prepare("SELECT amount_cents FROM transactions WHERE type = 'settle'").get();
  assert.strictEqual(settle.amount_cents, -200);
  const comm = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type = 'commission'").get();
  assert.strictEqual(comm.n, 0);
});

// L6: void refund — balance untouched, frozen released, refund row.
check('L6 void refund', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 200);
  L.settleUser(db, u.id, { balanceDelta: 0, frozenRelease: 200, refundCents: 200 });
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 0 });
  const refund = db.prepare("SELECT amount_cents FROM transactions WHERE type = 'refund'").get();
  assert.strictEqual(refund.amount_cents, 200);
});

// L7: balance_after/frozen_after chain exact across a sequence.
check('L7 ledger chain', () => {
  const { db, u } = fresh();
  L.deposit(db, u.id, 1000, 100000);
  L.escrow(db, u.id, 400);
  L.release(db, u.id, 100);
  L.settleUser(db, u.id, { balanceDelta: 150, frozenRelease: 300, commissionCents: 0 });
  const rows = db
    .prepare('SELECT type, amount_cents a, balance_after b, frozen_after f FROM transactions ORDER BY id')
    .all()
    .map((r) => ({ type: r.type, a: r.a, b: r.b, f: r.f }));
  const expected = [
    { type: 'deposit', a: 1000, b: 2000, f: 0 },
    { type: 'escrow', a: 400, b: 2000, f: 400 },
    { type: 'release', a: 100, b: 2000, f: 300 },
    { type: 'settle', a: 150, b: 2150, f: 0 },
  ];
  assert.deepStrictEqual(rows, expected);
});

// L8: integrity — releasing more than frozen rejects with NO partial state.
check('L8 integrity guard', () => {
  const { db, u } = fresh();
  L.escrow(db, u.id, 200);
  assert.throws(
    () => L.settleUser(db, u.id, { balanceDelta: 150, frozenRelease: 201 }),
    (e) => e.status === 500
  );
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 200 }); // untouched
  const n = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  assert.strictEqual(n, 1); // only the escrow row
});

// L9: atomicity — a failed op leaves zero rows and no balance change.
check('L9 atomicity on failure', () => {
  const { db, u } = fresh();
  assert.throws(() => L.deposit(db, u.id, 200000, 100000), (e) => e.status === 400);
  assert.deepStrictEqual(balanceOf(db, u.id), { b: 1000, f: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0);
});

// L10: walletView shape.
check('L10 walletView', () => {
  const { db, u } = fresh();
  L.deposit(db, u.id, 500, 100000);
  L.escrow(db, u.id, 300);
  const w = L.walletView(db, u.id);
  assert.deepStrictEqual(
    { b: w.balance_cents, f: w.frozen_cents, a: w.available_cents },
    { b: 1500, f: 300, a: 1200 }
  );
  assert.ok(Array.isArray(w.transactions) && w.transactions.length === 2);
});

console.log(`\nledger.test.js: ${passed} checks passed`);
