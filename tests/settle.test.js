// settle.test.js — market settlement: pot distribution + commission.
// Run: node tests/settle.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const S = require('../lib/settle');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

let evCounter = 0;

function fresh() {
  const db = openStore(':memory:');
  const mk = (name, bal) => A.registerUser(db, { username: name, password: 'secret1', balance_cents: bal });
  return {
    db,
    users: { alice: mk('alice', 100000), bob: mk('bob', 100000), carol: mk('carol', 100000), dave: mk('dave', 100000) },
  };
}

function mkMarket(db, selections) {
  let sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  if (!sport) {
    db.prepare("INSERT INTO sports (name, slug) VALUES ('Football', 'football')").run();
    sport = db.prepare("SELECT id FROM sports WHERE slug = 'football'").get();
  }
  evCounter++;
  db.prepare("INSERT INTO events (sport_id, name, starts_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(sport.id, `Test Event ${evCounter}`);
  const ev = db.prepare('SELECT id FROM events WHERE name = ?').get(`Test Event ${evCounter}`);
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Match Odds')").run(ev.id);
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(ev.id);
  return addSelections(db, mkt.id, selections);
}

function addSelections(db, marketId, selections) {
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(marketId, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(marketId, name).id);
  }
  return { market_id: marketId, s1: ids[0], s2: ids[1] };
}

const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};

// S1: back wins — pot s*Q to the backer, commission on net winnings.
// alice back 10000 @ 2.0 vs bob lay 10000 @ 2.0; winner Alpha.
// alice: +10000 profit, -250 commission -> 109750; bob: -10000 -> 90000.
check('S1 back wins', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const res = S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.strictEqual(res.market.status, 'settled');
  assert.strictEqual(res.market.winner_selection_id, s1);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109750, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 90000, f: 0 });
  const rows = db.prepare('SELECT user_id, credit_cents c, commission_cents k, pnl_cents p FROM settlements ORDER BY user_id').all()
    .map((r) => ({ user_id: r.user_id, c: r.c, k: r.k, p: r.p }));
  const alice = rows.find((r) => r.user_id === users.alice.id);
  const bob = rows.find((r) => r.user_id === users.bob.id);
  assert.deepStrictEqual(alice, { user_id: users.alice.id, c: 20000, k: 250, p: 10000 }); // pot 20000 received
  assert.deepStrictEqual(bob, { user_id: users.bob.id, c: 0, k: 0, p: -10000 });
  // conservation: total money = 400000 (4 users) - 250 (commission is house revenue)
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 399750);
  // single-market event completes
  const ev = db.prepare("SELECT status FROM events WHERE id = (SELECT event_id FROM markets WHERE id = ?)").get(market_id);
  assert.strictEqual(ev.status, 'completed');
});

// S2: back loses — the layer wins and pays the commission.
check('S2 back loses (layer wins)', () => {
  const { db, users } = fresh();
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { winner_selection_id: s2 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 90000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 109750, f: 0 }); // 100000 + 10000 - 250
});

// S3: lay win at high odds — full liability escrow returned (E3b regression
// at settlement): bob lay 10000 @ 3.0 (escrow 20000) + profit 10000 - 250.
check('S3 lay wins at high odds returns escrow', () => {
  const { db, users } = fresh();
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 3.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 3.0, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 3.0, stake_cents: 10000 }); // sweeps bob's lay
  S.settleMarket(db, market_id, { winner_selection_id: s2 }); // Alpha loses -> lay wins
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 109750, f: 0 });
  const row = db.prepare('SELECT credit_cents c, pnl_cents p FROM settlements WHERE user_id = ?').get(users.bob.id);
  assert.strictEqual(row.c, 30000); // 20000 escrow + 10000 profit
  assert.strictEqual(row.p, 10000);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 90000, f: 0 });
});

// S4: market void — everyone gets their own contribution back, untouched.
check('S4 void refunds own contributions', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { void: true });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 });
  const refund = db.prepare("SELECT amount_cents a FROM transactions WHERE type = 'refund'").get();
  assert.strictEqual(refund.a, 10000);
  const mkt = db.prepare('SELECT winner_selection_id w, status s FROM markets WHERE id = ?').get(market_id);
  assert.strictEqual(mkt.w, null);
  assert.strictEqual(mkt.s, 'settled');
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 400000); // conserved
});

// S5: unmatched orders auto-cancel at settlement (escrow released, no
// settlement rows for users without matches).
check('S5 unmatched auto-cancelled', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 1.98, stake_cents: 5000 }); // rests
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 }); // 4900 liability released
  const n = db.prepare('SELECT COUNT(*) n FROM settlements').get().n;
  assert.strictEqual(n, 0);
  const statuses = db.prepare("SELECT status FROM orders").all().map((r) => r.status);
  assert.ok(statuses.every((s) => s === 'cancelled'));
});

// S6: re-settling a settled market is a hard error — no double-pay.
check('S6 re-settle guard', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.throws(() => S.settleMarket(db, market_id, { winner_selection_id: s1 }), (e) => e.status === 409);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109750, f: 0 }); // untouched
});

// S7: commission charges the NET across matches, not per-match:
// alice wins 5050+5050 = 10100 -> commission round(10100*0.025) = 253
// (per-match rounding would give 126+126 = 252).
check('S7 commission on net', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 5050 });
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 5050 });
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 109847, f: 0 }); // 100000 + 10100 - 253
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 94950, f: 0 });
  assert.deepStrictEqual(balances(db, users.dave.id), { b: 94950, f: 0 });
  const total = db.prepare('SELECT SUM(balance_cents) t FROM users').get().t;
  assert.strictEqual(total, 400000 - 253);
});

// S8: an event completes only when ALL of its markets are settled.
check('S8 event completion across markets', () => {
  const { db, users } = fresh();
  const { market_id: mA, s1: a1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const evId = db.prepare('SELECT event_id FROM markets WHERE id = ?').get(mA).event_id;
  db.prepare("INSERT INTO markets (event_id, name) VALUES (?, 'Over/Under 2.5')").run(evId);
  const mB = db.prepare('SELECT id FROM markets WHERE event_id = ? ORDER BY id DESC').get(evId).id;
  const { s1: b1 } = addSelections(db, mB, [['Over', 1.9], ['Under', 2.0]]);
  S.settleMarket(db, mA, { winner_selection_id: a1 });
  let ev = db.prepare('SELECT status FROM events WHERE id = ?').get(evId);
  assert.strictEqual(ev.status, 'upcoming'); // one market still open
  S.settleMarket(db, mB, { winner_selection_id: b1 });
  ev = db.prepare('SELECT status FROM events WHERE id = ?').get(evId);
  assert.strictEqual(ev.status, 'completed');
});

// S9: settled markets reject new orders.
check('S9 settled market frozen', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  S.settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.throws(
    () => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }),
    (e) => e.status === 409
  );
});

// S10: void refunds a lay at its MATCH price liability (excess already
// released at match time): bob lay 10000 @ 2.1 matched at 2.0 -> frozen
// 10000 (not 11000); void refunds exactly 10000.
check('S10 void after lay excess release', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 }); // matches at 2.0, excess 1000 released
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 });
  S.settleMarket(db, market_id, { void: true });
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 }); // refunded 10000, not 11000
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
});

console.log(`\nsettle.test.js: ${passed} checks passed`);
