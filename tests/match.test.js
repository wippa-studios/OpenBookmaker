// match.test.js — the matching engine: sweeps, resting price, escrow, guards.
// Run: node tests/match.test.js   (plain assert, no deps)
// Hand-computed examples mirror JIT paper_math E1–E9 semantics.
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');
const M = require('../lib/match');

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
  const mkt = db.prepare('SELECT id FROM markets WHERE event_id = ?').get(ev.id);
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
const orderOf = (db, id) => {
  const r = db.prepare('SELECT matched_cents m, status s FROM orders WHERE id = ?').get(id);
  return { matched: r.m, status: r.s };
};
const matchesFor = (db, marketId) =>
  db.prepare('SELECT price, stake_cents s FROM matches WHERE market_id = ? ORDER BY id').all(marketId).map((r) => ({ price: r.price, stake: r.s }));

// E1: back taker matches a resting lay AT THE RESTING PRICE.
check('E1 back matches resting lay at resting price', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 0, status: 'open' }); // no liquidity yet
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // stake escrowed
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, b.order.id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 10000 }]);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // matched pot stays frozen
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 }); // liability (2.0-1)*10000
});

// E2: partial fill — remainder rests.
check('E2 partial fill', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 6000 });
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 6000, status: 'open' });
  assert.deepStrictEqual(orderOf(db, b.order.id), { matched: 6000, status: 'fully_matched' });
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 6000 }]);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 10000 }); // matched 6000 + resting 4000
});

// E3: lay taker matched at P < own price Q releases (Q-P)*fill excess.
check('E3 lay excess escrow released', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order; // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 });
  // escrowed (2.1-1)*10000 = 11000; matched at 2.0 -> liability 10000; excess 1000 released
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10000 });
  const txs = db.prepare("SELECT type, amount_cents a FROM transactions WHERE user_id = ? ORDER BY id").all(users.bob.id).map((r) => ({ type: r.type, a: r.a }));
  assert.deepStrictEqual(txs, [{ type: 'escrow', a: 11000 }, { type: 'release', a: 1000 }]);
  assert.deepStrictEqual(matchesFor(db, market_id), [{ price: 2.0, stake: 10000 }]);
  assert.deepStrictEqual(orderOf(db, a.id), { matched: 10000, status: 'fully_matched' });
});

// E4: back taker sweeps resting lays HIGHEST price first (best-for-taker).
check('E4 back sweep highest-first', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.06, stake_cents: 10000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.02, stake_cents: 5000 });
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.02, stake_cents: 12000 });
  assert.deepStrictEqual(matchesFor(db, market_id), [
    { price: 2.06, stake: 10000 }, // best price first — backer gets better than demanded
    { price: 2.02, stake: 2000 },
  ]);
  assert.deepStrictEqual(orderOf(db, a.order.id), { matched: 12000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, db.prepare("SELECT id FROM orders WHERE user_id = ? AND side='lay' AND price=2.06").get(users.bob.id).id), { matched: 10000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, db.prepare("SELECT id FROM orders WHERE user_id = ? AND side='lay' AND price=2.02").get(users.carol.id).id), { matched: 2000, status: 'open' });
  const sel = db.prepare('SELECT ltp FROM selections WHERE id = ?').get(s1);
  assert.strictEqual(sel.ltp, 2.02); // last traded
});

// E5: lay taker sweeps resting backs LOWEST price first (least liability).
check('E5 lay sweep lowest-first', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 1.98, stake_cents: 10000 }); // rests
  M.placeOrder(db, users.dave, { selection_id: s1, side: 'back', price: 2.04, stake_cents: 5000 }); // rests
  const b = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 12000 });
  assert.deepStrictEqual(matchesFor(db, market_id), [
    { price: 1.98, stake: 10000 }, // lowest eligible back first
    { price: 2.04, stake: 2000 },
  ]);
  // escrowed (2.1-1)*12000 = 13200; released (2.1-1.98)*10000=1200 + (2.1-2.04)*2000=120
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 11880 });
  const txs = db.prepare("SELECT type, amount_cents a FROM transactions WHERE user_id = ? ORDER BY id").all(users.bob.id).map((r) => ({ type: r.type, a: r.a }));
  assert.deepStrictEqual(txs, [
    { type: 'escrow', a: 13200 },
    { type: 'release', a: 1200 },
    { type: 'release', a: 120 },
  ]);
});

// E6: self-match guard — a user never matches their own resting order.
check('E6 self-match guard', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  const l = M.placeOrder(db, users.alice, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  assert.deepStrictEqual(orderOf(db, l.order.id), { matched: 0, status: 'open' }); // own back skipped
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM matches').get().n, 0);
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 20000 });
});

// E7: cancel releases the stake escrow; double-cancel and foreign orders reject.
check('E7 cancel back order', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const a = M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }).order;
  const cancelled = M.cancelOrder(db, users.alice, a.id);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.deepStrictEqual(balances(db, users.alice.id), { b: 100000, f: 0 });
  assert.throws(() => M.cancelOrder(db, users.alice, a.id), (e) => e.status === 400);
  const other = M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.05, stake_cents: 10000 }).order;
  assert.throws(() => M.cancelOrder(db, users.alice, other.id), (e) => e.status === 404);
});

// E8: cancel a resting lay releases the FULL liability escrow.
check('E8 cancel lay order', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  const l = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.1, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 11000 });
  M.cancelOrder(db, users.bob, l.id);
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 0 });
});

// E9: order validation — stake bounds, side, suspended market.
check('E9 validation', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 50 }), (e) => e.status === 400); // below MIN 100
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: '10000' }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'x', price: 2.0, stake_cents: 10000 }), (e) => e.status === 400);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 200000 }), (e) => e.status === 400); // above MAX
  db.prepare("UPDATE markets SET status = 'suspended' WHERE id = ?").run(market_id);
  assert.throws(() => M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 }), (e) => e.status === 409);
});

// E10: LTP, trade tape and market volume update on fills.
check('E10 LTP + trade tape + volume', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 10000 });
  const sel = db.prepare('SELECT ltp FROM selections WHERE id = ?').get(s1);
  assert.strictEqual(sel.ltp, 2.0);
  const hist = db.prepare('SELECT price FROM price_history WHERE selection_id = ?').all(s1);
  assert.deepStrictEqual(hist.map((r) => r.price), [2.0]);
  const mkt = db.prepare('SELECT total_matched_cents t FROM markets WHERE id = ?').get(market_id);
  assert.strictEqual(mkt.t, 10000);
});

// E11: bookFor aggregates sizes at each price level, back DESC / lay ASC.
check('E11 book aggregation + ordering', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 10000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.1, stake_cents: 10000 });
  // A resting lay must price BELOW the resting backs or it would have swept
  // them on arrival (real-exchange book consistency: back side < lay side).
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 1.99, stake_cents: 5000 });
  const book = M.bookFor(db, db.prepare('SELECT market_id FROM selections WHERE id = ?').get(s1).market_id);
  const row = book.find((b) => b.selection_id === s1);
  assert.deepStrictEqual(row.back, [{ price: 1.99, size_cents: 5000 }]); // resting lays, highest first
  assert.deepStrictEqual(row.lay, [
    { price: 2.0, size_cents: 20000 }, // aggregated at level
    { price: 2.1, size_cents: 10000 },
  ]); // resting backs, lowest first
});

// E12: lay escrow rounding is exact at 2dp prices (single rounding point).
check('E12 escrow float exactness', () => {
  const { db, users } = fresh();
  const { s1 } = mkMarket(db, [['Alpha', 2.02], ['Beta', 3.0]]);
  const l = M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.02, stake_cents: 10000 }).order;
  assert.deepStrictEqual(balances(db, users.bob.id), { b: 100000, f: 10200 }); // round(1.02*10000)
  assert.strictEqual(l.price, 2.02); // snapped input stays on the ladder
});

// E13: FIFO within a price level — two resting lays at the SAME price, the
// older order must fill first (price-time priority, not arbitrary).
check('E13 FIFO within a price level', () => {
  const { db, users } = fresh();
  const { market_id, s1 } = mkMarket(db, [['Alpha', 2.0], ['Beta', 2.2]]);
  M.placeOrder(db, users.bob, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 });
  M.placeOrder(db, users.carol, { selection_id: s1, side: 'lay', price: 2.0, stake_cents: 4000 });
  M.placeOrder(db, users.alice, { selection_id: s1, side: 'back', price: 2.0, stake_cents: 6000 });
  const rows = db
    .prepare(
      `SELECT m.stake_cents s, bo.placed_at t FROM matches m
       JOIN orders bo ON bo.id = m.back_order_id
       JOIN orders lo ON lo.id = m.lay_order_id
       WHERE m.market_id = ? ORDER BY m.id`
    )
    .all(market_id);
  // The OLDER lay (bob) is filled first, even though carol's sits at the same price.
  assert.deepStrictEqual(rows.map((r) => r.s), [4000, 2000]);
  const bobId = db.prepare("SELECT id FROM orders WHERE user_id = ? AND side = 'lay'").get(users.bob.id).id;
  const carolId = db.prepare("SELECT id FROM orders WHERE user_id = ? AND side = 'lay'").get(users.carol.id).id;
  assert.ok(bobId < carolId, 'bob rested first');
  assert.deepStrictEqual(orderOf(db, bobId), { matched: 4000, status: 'fully_matched' });
  assert.deepStrictEqual(orderOf(db, carolId), { matched: 2000, status: 'open' });
});

console.log(`\nmatch.test.js: ${passed} checks passed`);
