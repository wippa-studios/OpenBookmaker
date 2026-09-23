// cashout.test.js — green-up close at top of book (house paper_math formulas).
// Run: node tests/cashout.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');
const C = require('../lib/cashout');

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
  const ids = [];
  for (const [name, fair] of selections) {
    db.prepare('INSERT INTO selections (market_id, name, fair_price) VALUES (?, ?, ?)').run(mkt.id, name, fair);
    ids.push(db.prepare('SELECT id FROM selections WHERE market_id = ? AND name = ?').get(mkt.id, name).id);
  }
  return { market_id: mkt.id, s1: ids[0], s2: ids[1] };
}

const balances = (db, id) => {
  const r = db.prepare('SELECT balance_cents b, frozen_cents f FROM users WHERE id = ?').get(id);
  return { b: r.b, f: r.f };
};

// C1: back cashout when the price came IN (winning back).
// alice back 10000 @ 2.0 (matched); price in to 1.90; hedge lay
// round(10000*2/1.9) = 10526 -> locked value 526. Green within a cent.
check('C1 back cashout, price in', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 20000 }); // rests
  const res = C.cashoutMarket(db, users.alice, market_id);
  assert.strictEqual(res.value_cents, 526); // 100*(2-1.9)/1.9 = 5.263 -> 526c
  assert.strictEqual(res.hedge_price, 1.9);
  assert.strictEqual(res.hedge_order.status, 'fully_matched');
  assert.deepStrictEqual(res.fills, [{ price: 1.9, stake_cents: 10526 }]);
  // hedge lay escrow round(0.9*10526) = 9473 on top of the matched pot 10000
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 19473 });
  // green: if-win 527 / if-lose 526 (within a cent — integer hedge)
  const pos = M.positionsFor(db, users.alice.id).find((p) => p.market_id === market_id);
  const pnls = pos.pnl_if_win.map((x) => x.pnl_cents);
  assert.ok(Math.abs(pnls[0] - pnls[1]) <= 1, `green within a cent: ${JSON.stringify(pnls)}`);
  assert.ok(pnls[0] >= 526);
  // carol's back partially filled
  const carolBal = balances(db, users.carol.id);
  assert.strictEqual(carolBal.f, 20000); // 13333... matched + remainder
});

// C2: lay cashout when the price drifted OUT (winning lay).
// bob lay 10000 @ 2.0 (matched); price out to 2.20; hedge back
// round(10000*2/2.2) = 9091 -> locked value 909. Exact green.
check('C2 lay cashout, price out', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'lay', price: 2.2, stake_cents: 30000 }); // rests
  const res = C.cashoutMarket(db, users.bob, market_id);
  assert.strictEqual(res.value_cents, 909); // 100*(2.2-2)/2.2 = 9.09 -> 909c
  assert.strictEqual(res.hedge_order.status, 'fully_matched');
  assert.deepStrictEqual(res.fills, [{ price: 2.2, stake_cents: 9091 }]);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 19091 }); // pot 10000 + hedge escrow 9091
  const pos = M.positionsFor(db, users.bob.id).find((p) => p.market_id === market_id);
  const pnls = pos.pnl_if_win.map((x) => x.pnl_cents);
  assert.deepStrictEqual(pnls, [909, 909]); // exact green
});

// C3: insufficient liquidity rejects with NOTHING changed (atomic rollback).
check('C3 insufficient liquidity is atomic', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 5000 }); // hedge needs 10526
  const before = balances(db, users.alice.id);
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), (e) => e.status === 409);
  assert.deepStrictEqual(balances(db, users.alice.id), before);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 1); // no hedge matches
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND side = 'lay'").get(users.alice.id).n, 0);
  // dave's resting order untouched
  const dave = db.prepare("SELECT status FROM orders WHERE user_id = ? AND side = 'back' AND price = 1.9").get(users.dave.id);
  assert.strictEqual(dave.status, 'open');
});

// C4: after a cashout the position is mixed — a second cashout is refused.
check('C4 mixed position refused', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 20000 });
  C.cashoutMarket(db, users.alice, market_id);
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), (e) => e.status === 409);
});

// C5: multi-selection positions are refused (v1 scope).
check('C5 multi-selection refused', () => {
  const { db, users } = fresh();
  const { market_id, s1, s2 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s2, side: 'back', price: 2.2, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s2, side: 'lay', price: 2.2, stake_cents: 10000 });
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), (e) => e.status === 409);
});

// C6: no matched position -> refused.
check('C6 no position refused', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }); // rests, no match
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), (e) => e.status === 409);
});

// C7: settled markets can't be cashed out.
check('C7 settled market refused', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const { settleMarket } = require('../lib/settle');
  settleMarket(db, market_id, { winner_selection_id: s1 });
  assert.throws(() => C.cashoutMarket(db, users.alice, market_id), (e) => e.status === 409);
});

// C8: cashoutQuote is display-only — quotes without executing anything.
check('C8 quote does not execute', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'back', price: 1.9, stake_cents: 20000 });
  const q = C.cashoutQuote(db, users.alice, market_id);
  assert.strictEqual(q.value_cents, 526);
  assert.strictEqual(q.hedge_price, 1.9);
  assert.strictEqual(q.hedge_side, 'lay');
  // nothing executed
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 3);
});

console.log(`\ncashout.test.js: ${passed} checks passed`);
