'use strict';
// lib/match.js — the matching engine (the heart of the exchange).
//
// Semantics (Betfair-correct, per PLAN):
//   - Back @P (stake S, backer-stake units): sweeps resting LAY offers with
//     Q >= P, HIGHEST Q first (best-for-taker), matched AT THE RESTING
//     order's price Q. Remainder rests as a back offer at P.
//   - Lay @Q (accepts backer stake S): sweeps resting BACK offers with
//     P <= Q, LOWEST P first (least liability), matched at the resting P.
//     Remainder rests as a lay offer at Q.
//   - Escrow at placement: back freezes S; lay freezes (Q-1)*S at own price.
//     A lay matched at P <= Q releases (Q-P)*s of excess per fill.
//   - Self-match guard: a user never matches their own resting order.
//   - Pot per match: s (backer) + (P-1)*s (layer); settlement pays the
//     winner side the pot (see lib/settle.js).
const { httpError } = require('./auth');
const { escrow, release, availableOf, getUser } = require('./ledger');
const { transaction, inTransaction } = require('./tx');
const { snapToTick, impliedProb } = require('./odds');
const config = require('./config');

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getSelection(db, selectionId) {
  const sel = db
    .prepare(
      `SELECT s.id AS selection_id, s.market_id, s.name, s.status AS selection_status,
              m.status AS market_status, e.status AS event_status
       FROM selections s
       JOIN markets m ON m.id = s.market_id
       JOIN events e ON e.id = m.event_id
       WHERE s.id = ?`
    )
    .get(selectionId);
  if (!sel) throw httpError(404, 'Selection not found');
  return sel;
}

function escrowFor(side, price, stake) {
  // Single rounding point (house rule): round the one liability computation.
  return side === 'back' ? stake : Math.round((price - 1) * stake);
}

function validateOrder(db, user, { selection_id, side, price, stake_cents }) {
  if (side !== 'back' && side !== 'lay') throw httpError(400, 'side must be "back" or "lay"');
  // Type-strict boundary (house lesson: Number('1')/Number(true) coercion slips).
  if (typeof stake_cents !== 'number' || !Number.isInteger(stake_cents) || stake_cents < config.MIN_STAKE_CENTS || stake_cents > config.MAX_STAKE_CENTS) {
    throw httpError(400, `Stake must be an integer between ${config.MIN_STAKE_CENTS} and ${config.MAX_STAKE_CENTS} cents`);
  }
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw httpError(400, 'Price must be a number');
  }
  const stake = stake_cents;
  const p = snapToTick(price);
  if (!(p >= 1.01 && p <= 1000)) throw httpError(400, 'Price out of range');
  const sel = getSelection(db, selection_id);
  if (sel.market_status !== 'open') throw httpError(409, 'Market is not open');
  if (sel.selection_status !== 'open') throw httpError(409, 'Selection is not open');
  if (sel.event_status === 'completed') throw httpError(409, 'Event is completed');
  return { stake, price: p, sel };
}

function recordMatch(db, { marketId, selectionId, backOrderId, layOrderId, price, stake }) {
  db.prepare(
    'INSERT INTO matches (market_id, selection_id, back_order_id, lay_order_id, price, stake_cents) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(marketId, selectionId, backOrderId, layOrderId, price, stake);
}

function updateRest(db, o, fill) {
  const matched = o.matched_cents + fill;
  const status = matched >= o.stake_cents ? 'fully_matched' : 'open';
  db.prepare('UPDATE orders SET matched_cents = ?, status = ?, updated_at = ? WHERE id = ?').run(matched, status, now(), o.id);
}

// Place an order: validate -> escrow -> sweep the opposite book -> rest the
// remainder -> LTP/history/volume. Atomic (one transaction; ledger ops nest
// via their own SAVEPOINTs).
function placeOrder(db, user, req) {
  return transaction(db, () => placeOrderTx(db, user, req));
}

// The matching body with NO transaction of its own: the caller owns one.
// Exported for cash-out, which must span the hedge's full-fill check inside a
// single transaction (a partial hedge fill rolls back entirely). Calling this
// directly would write an order, matches and ledger rows without a rollback
// point, so it refuses to run outside one.
function placeOrderTx(db, user, req) {
  if (!inTransaction()) {
    throw httpError(500, 'placeOrderTx must be called inside a transaction (use placeOrder)');
  }
  const { stake, price, sel } = validateOrder(db, user, req);
  const esc = escrowFor(req.side, price, stake);

  const u = getUser(db, user.id);
    if (availableOf(u) < esc) {
      throw httpError(400, 'Insufficient available balance for the stake/liability');
    }
    escrow(db, u.id, esc, { marketId: sel.market_id });

    // Insert first so match rows can reference this order.
    const info = db
      .prepare(
        `INSERT INTO orders (user_id, market_id, selection_id, side, price, stake_cents, matched_cents, status, placed_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'open', ?)`
      )
      .run(u.id, sel.market_id, sel.selection_id, req.side, price, stake, now());
    const orderId = info.lastInsertRowid;

    const fills = [];
    let remaining = stake;

    if (req.side === 'back') {
      // Taker sweep: resting lays eligible at Q >= price, HIGHEST price first.
      const rests = db
        .prepare(
          `SELECT * FROM orders WHERE selection_id = ? AND side = 'lay' AND status = 'open' AND price >= ?
           ORDER BY price DESC, id ASC`
        )
        .all(sel.selection_id, price);
      for (const o of rests) {
        if (remaining === 0) break;
        if (o.user_id === u.id) continue; // self-match guard
        const avail = o.stake_cents - o.matched_cents;
        if (avail <= 0) continue;
        const fill = Math.min(remaining, avail);
        recordMatch(db, {
          marketId: sel.market_id,
          selectionId: sel.selection_id,
          backOrderId: orderId,
          layOrderId: o.id,
          price: o.price, // resting order's price stands
          stake: fill,
        });
        updateRest(db, o, fill);
        remaining -= fill;
        fills.push({ price: o.price, stake_cents: fill });
      }
    } else {
      // Taker sweep: resting backs eligible at P <= price, LOWEST price first
      // (the layer's liability at the match price is (P-1)*fill).
      const rests = db
        .prepare(
          `SELECT * FROM orders WHERE selection_id = ? AND side = 'back' AND status = 'open' AND price <= ?
           ORDER BY price ASC, id ASC`
        )
        .all(sel.selection_id, price);
      for (const o of rests) {
        if (remaining === 0) break;
        if (o.user_id === u.id) continue; // self-match guard
        const avail = o.stake_cents - o.matched_cents;
        if (avail <= 0) continue;
        const fill = Math.min(remaining, avail);
        recordMatch(db, {
          marketId: sel.market_id,
          selectionId: sel.selection_id,
          backOrderId: o.id,
          layOrderId: orderId,
          price: o.price, // resting order's price stands
          stake: fill,
        });
        updateRest(db, o, fill);
        // Escrowed (Q-1)*fill at own price; owed (P-1)*fill at match price —
        // release the (Q-P)*fill excess.
        const excess = Math.round((price - o.price) * fill);
        if (excess > 0) release(db, u.id, excess, { orderId, marketId: sel.market_id });
        remaining -= fill;
        fills.push({ price: o.price, stake_cents: fill });
      }
    }

    const matched = stake - remaining;
    if (remaining === 0) {
      db.prepare("UPDATE orders SET matched_cents = ?, status = 'fully_matched', updated_at = ? WHERE id = ?").run(matched, now(), orderId);
    } else {
      db.prepare('UPDATE orders SET matched_cents = ?, updated_at = ? WHERE id = ?').run(matched, now(), orderId);
    }

    if (fills.length > 0) {
      // Trade tape: one row per fill; LTP = last traded price.
      for (const f of fills) {
        db.prepare('INSERT INTO price_history (selection_id, price) VALUES (?, ?)').run(sel.selection_id, f.price);
      }
      db.prepare('UPDATE selections SET ltp = ? WHERE id = ?').run(fills[fills.length - 1].price, sel.selection_id);
      db.prepare('UPDATE markets SET total_matched_cents = total_matched_cents + ? WHERE id = ?').run(matched, sel.market_id);
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    return { order, fills, book: bookFor(db, sel.market_id) };
}

// Cancel the UNMATCHED remainder of an open order (releases its escrow).
function cancelOrder(db, user, orderId) {
  return transaction(db, () => cancelOrderTx(db, user, orderId));
}

function cancelOrderTx(db, user, orderId) {
  {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o || o.user_id !== user.id) throw httpError(404, 'Order not found');
    if (o.status === 'cancelled') throw httpError(400, 'Order already cancelled');
    if (o.status === 'fully_matched') throw httpError(400, 'Order is fully matched — nothing to cancel');
    const remainder = o.stake_cents - o.matched_cents;
    const esc = o.side === 'back' ? remainder : Math.round((o.price - 1) * remainder);
    if (esc > 0) release(db, user.id, esc, { orderId: o.id, marketId: o.market_id });
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  }
}

// Open (unmatched-remainder) orders for a user, with names joined.
function openOrdersFor(db, userId) {
  return db
    .prepare(
      `SELECT o.id, o.side, o.price, o.stake_cents, o.matched_cents, o.status, o.placed_at,
              o.selection_id, s.name AS selection_name, m.name AS market_name, e.name AS event_name
       FROM orders o
       JOIN selections s ON s.id = o.selection_id
       JOIN markets m ON m.id = o.market_id
       JOIN events e ON e.id = m.event_id
       WHERE o.user_id = ? AND o.status = 'open'
       ORDER BY o.id DESC`
    )
    .all(userId);
}

// Aggregated price levels for every selection in a market.
//   back side ("available to back") = resting LAY offers, HIGHEST price first.
//   lay side ("available to lay") = resting BACK offers, LOWEST price first.
function bookFor(db, marketId, levels = 3) {
  const sels = db.prepare('SELECT id, name, status, ltp FROM selections WHERE market_id = ? ORDER BY id').all(marketId);
  return sels.map((s) => {
    const back = db
      .prepare(
        `SELECT price, SUM(stake_cents - matched_cents) AS size_cents FROM orders
         WHERE selection_id = ? AND side = 'lay' AND status = 'open' AND stake_cents > matched_cents
         GROUP BY price ORDER BY price DESC LIMIT ?`
      )
      .all(s.id, levels)
      .map((r) => ({ price: r.price, size_cents: r.size_cents }));
    const lay = db
      .prepare(
        `SELECT price, SUM(stake_cents - matched_cents) AS size_cents FROM orders
         WHERE selection_id = ? AND side = 'back' AND status = 'open' AND stake_cents > matched_cents
         GROUP BY price ORDER BY price ASC LIMIT ?`
      )
      .all(s.id, levels)
      .map((r) => ({ price: r.price, size_cents: r.size_cents }));
    return { selection_id: s.id, name: s.name, status: s.status, ltp: s.ltp, back, lay };
  });
}

// Book overround for a market: the sum of the implied probability of the best
// price a backer can get on each runner, minus 1. On an exchange this is the
// desk's margin/arbitrage signal — negative means the runners can all be backed
// for a guaranteed profit. null when a runner has no available liquidity,
// because a partial book cannot be summed meaningfully.
function marketOverround(db, marketId) {
  const book = bookFor(db, marketId, 1);
  if (!book.length) return null;
  let sum = 0;
  for (const sel of book) {
    const best = sel.back[0]; // resting lays, highest first = best price to back
    if (!best) return null;
    sum += impliedProb(best.price);
  }
  return sum - 1;
}

// The user's matched bets (rows tagged with my_side) across all markets, or
// scoped to one market when marketId is given.
function myMatchedBets(db, userId, marketId = null) {
  const sql = `SELECT mt.market_id, mt.selection_id, mt.price, mt.stake_cents,
            CASE WHEN bo.user_id = ? THEN 'back' ELSE 'lay' END AS my_side
     FROM matches mt
     JOIN orders bo ON bo.id = mt.back_order_id
     JOIN orders lo ON lo.id = mt.lay_order_id
     WHERE (bo.user_id = ? OR lo.user_id = ?)${marketId ? ' AND mt.market_id = ?' : ''}`;
  const args = marketId ? [userId, userId, userId, marketId] : [userId, userId, userId];
  return db.prepare(sql).all(...args);
}

// Matched positions for a user across all markets: per-selection matched
// stake/liability + the if-win P&L matrix (cashout values are added by
// lib/cashout.js).
function positionsFor(db, userId) {
  const markets = db
    .prepare(
      `SELECT DISTINCT m.id AS market_id, m.name AS market_name, m.status AS market_status,
              m.winner_selection_id, e.name AS event_name
       FROM matches mt
       JOIN orders bo ON bo.id = mt.back_order_id
       JOIN orders lo ON lo.id = mt.lay_order_id
       JOIN markets m ON m.id = mt.market_id
       JOIN events e ON e.id = m.event_id
       WHERE bo.user_id = ? OR lo.user_id = ?
       ORDER BY m.id DESC`
    )
    .all(userId, userId);

  const myBets = myMatchedBets(db, userId);

  return markets.map((m) => {
    const sels = db
      .prepare('SELECT id, name, status FROM selections WHERE market_id = ? ORDER BY id')
      .all(m.market_id);
    const legs = sels.map((s) => {
      const bets = myBets.filter((b) => b.market_id === m.market_id && b.selection_id === s.id);
      const backStake = bets.filter((b) => b.my_side === 'back').reduce((a, b) => a + b.stake_cents, 0);
      const layStake = bets.filter((b) => b.my_side === 'lay').reduce((a, b) => a + b.stake_cents, 0);
      return {
        selection_id: s.id,
        name: s.name,
        status: s.status,
        my_back_stake_cents: backStake,
        my_lay_stake_cents: layStake,
        // Still-frozen matched escrow on this selection: back holds its
        // stake; a lay matched at price p holds (p-1)*stake.
        frozen_cents: bets.reduce(
          (a, b) => a + (b.my_side === 'back' ? b.stake_cents : Math.round((b.price - 1) * b.stake_cents)),
          0
        ),
      };
    });
    const pnlIfWin = sels.map((s) => {
      let pnl = 0;
      for (const b of myBets) {
        if (b.market_id !== m.market_id) continue;
        const profit = Math.round((b.price - 1) * b.stake_cents); // back profit == lay loss
        if (b.my_side === 'back') {
          pnl += b.selection_id === s.id ? profit : -b.stake_cents;
        } else {
          pnl += b.selection_id === s.id ? -profit : b.stake_cents;
        }
      }
      return { selection_id: s.id, name: s.name, pnl_cents: pnl };
    });
    return {
      market_id: m.market_id,
      market_name: m.market_name,
      event_name: m.event_name,
      market_status: m.market_status,
      winner_selection_id: m.winner_selection_id,
      selections: legs,
      pnl_if_win: pnlIfWin,
    };
  });
}

module.exports = {
  placeOrder,
  placeOrderTx,
  cancelOrder,
  openOrdersFor,
  bookFor,
  marketOverround,
  positionsFor,
  myMatchedBets,
};
