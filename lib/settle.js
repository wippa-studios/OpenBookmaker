'use strict';
// lib/settle.js — market settlement: pot distribution + commission.
//
// Pot accounting per match (stake s, match price Q): the pot is s (backer's
// escrow) + (Q-1)*s (layer's escrow) = s*Q. Winner side is credited the pot;
// void refunds each side's own contribution. Money is conserved except the
// commission, which is charged on NET winnings per user per market.
const { httpError } = require('./auth');
const { release, settleUser } = require('./ledger');
const { transaction } = require('./tx');
const config = require('./config');

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// settleMarket(marketId, {winner_selection_id} | {void: true})
// Settlement is irreversible, so validate the caller's intent STRICTLY:
// `void: "false"` must never void a market, and a winner must be a positive
// integer selection id (never a coerced boolean/string).
function settleMarket(db, marketId, opts = {}) {
  const { winner_selection_id: rawWinner = null, void: rawVoid = false } = opts || {};
  if (typeof rawVoid !== 'boolean') {
    throw httpError(400, 'void must be a boolean (true/false)');
  }
  if (rawVoid && rawWinner !== null) {
    throw httpError(400, 'Provide either a winner_selection_id or void:true, not both');
  }
  let winner = null;
  if (!rawVoid) {
    if (typeof rawWinner !== 'number' || !Number.isInteger(rawWinner) || rawWinner <= 0) {
      throw httpError(400, 'winner_selection_id must be a positive integer (or pass void: true)');
    }
    winner = rawWinner;
  }
  const voidMarket = rawVoid;

  return transaction(db, () => settleTx(db, marketId, winner, voidMarket));
}

function settleTx(db, marketId, winner, voidMarket) {
  {
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
    if (!market) throw httpError(404, 'Market not found');
    if (market.status === 'settled') throw httpError(409, 'Market already settled');

    if (voidMarket) {
      db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = NULL WHERE id = ?").run(now(), marketId);
      db.prepare("UPDATE selections SET status = 'void' WHERE market_id = ?").run(marketId);
    } else {
      const sel = db.prepare('SELECT * FROM selections WHERE id = ? AND market_id = ?').get(winner, marketId);
      if (!sel) throw httpError(400, 'Winner selection is not in this market');
      db.prepare("UPDATE markets SET status = 'settled', settled_at = ?, winner_selection_id = ? WHERE id = ?").run(now(), winner, marketId);
    }

    // 1. Auto-cancel unmatched orders (release remainder escrow).
    const openOrders = db.prepare("SELECT * FROM orders WHERE market_id = ? AND status = 'open'").all(marketId);
    for (const o of openOrders) {
      const remainder = o.stake_cents - o.matched_cents;
      const esc = o.side === 'back' ? remainder : Math.round((o.price - 1) * remainder);
      if (esc > 0) release(db, o.user_id, esc, { orderId: o.id, marketId });
      db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
    }

    // 2. Resolve matched bets -> per-user aggregates (pot accounting).
    const rows = db
      .prepare(
        `SELECT mt.back_order_id, mt.lay_order_id, mt.selection_id, mt.price, mt.stake_cents,
                bo.user_id AS back_user, lo.user_id AS lay_user
         FROM matches mt
         JOIN orders bo ON bo.id = mt.back_order_id
         JOIN orders lo ON lo.id = mt.lay_order_id
         WHERE mt.market_id = ?`
      )
      .all(marketId);

    const perUser = new Map();
    const acc = (uid, d, f, r) => {
      const cur = perUser.get(uid) || { balanceDelta: 0, frozenRelease: 0, refundCents: 0 };
      cur.balanceDelta += d;
      cur.frozenRelease += f;
      cur.refundCents += r;
      perUser.set(uid, cur);
    };

    for (const m of rows) {
      const s = m.stake_cents;
      const Q = m.price;
      const liability = Math.round((Q - 1) * s); // single rounding point (matches escrow)
      if (voidMarket) {
        acc(m.back_user, 0, s, s);
        acc(m.lay_user, 0, liability, liability);
      } else if (m.selection_id === winner) {
        // Backer wins: their own stake unfreezes, the layer's liability pays them.
        acc(m.back_user, liability, s, 0);
        acc(m.lay_user, -liability, liability, 0);
      } else {
        // Layer wins: the backer's stake pays them.
        acc(m.back_user, -s, s, 0);
        acc(m.lay_user, s, liability, 0);
      }
    }

    // 3. Settle per user: commission on NET winnings only (house pattern).
    const summary = [];
    for (const [uid, a] of perUser) {
      const pnl = a.balanceDelta; // net winnings (can be negative)
      const commission = pnl > 0 ? Math.round(pnl * config.COMMISSION_RATE) : 0;
      settleUser(db, uid, {
        balanceDelta: a.balanceDelta,
        frozenRelease: a.frozenRelease,
        commissionCents: commission,
        refundCents: voidMarket ? a.refundCents : 0,
        marketId,
      });
      // credit_cents = gross received back (risked + net) = the pot share won.
      db.prepare(
        'INSERT INTO settlements (market_id, user_id, credit_cents, commission_cents, pnl_cents) VALUES (?, ?, ?, ?, ?)'
      ).run(marketId, uid, a.frozenRelease + a.balanceDelta, commission, pnl);
      summary.push({ user_id: uid, pnl_cents: pnl, commission_cents: commission });
    }

    // 4. Event completes when all of its markets are settled.
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM markets WHERE event_id = ? AND status != 'settled'")
      .get(market.event_id).n;
    if (remaining === 0) {
      db.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(market.event_id);
    }

    const updated = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
    return { market: updated, per_user: summary };
  }
}

// Settled history for a user, from the precomputed settlements table.
function settledFor(db, userId) {
  return db
    .prepare(
      `SELECT st.*, m.name AS market_name, e.name AS event_name, s.name AS selection_name
       FROM settlements st
       JOIN markets m ON m.id = st.market_id
       JOIN events e ON e.id = m.event_id
       LEFT JOIN selections s ON s.id = m.winner_selection_id
       WHERE st.user_id = ?
       ORDER BY st.id DESC`
    )
    .all(userId);
}

module.exports = { settleMarket, settledFor };
