'use strict';
// lib/cashout.js — close a single-selection, single-side matched position at
// top of book (green-up close).
//
// House paper_math formulas (divide by the CURRENT price — the hedge stake
// scales as 1/n):
//   back matched @e, hedge lay L at n  ->  L = round(Σ s_i·e_i / n),
//      locked value = L − S  (positive when the price came IN)
//   lay matched @e, hedge back B at n  ->  B = round(Σ s_i·e_i / n),
//      locked value = S − B  (positive when the price drifted OUT)
// v1 scope: single-selection, single-side positions (multiple matches on the
// one selection aggregate cleanly). Mixed or multi-selection: manual trade.
const { httpError } = require('./auth');
const M = require('./match');
const { getUser, availableOf } = require('./ledger');
const { transaction } = require('./tx');
const config = require('./config');

// Compute the cashout plan, or null when unsupported (no position / mixed /
// settled market / no liquidity / below minimum).
function computeCashoutPlan(db, user, marketId) {
  const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (!market || market.status !== 'open') return null;
  const bets = M.myMatchedBets(db, user.id, marketId);
  if (!bets.length) return null;
  const sels = [...new Set(bets.map((b) => b.selection_id))];
  const sides = [...new Set(bets.map((b) => b.my_side))];
  if (sels.length !== 1 || sides.length !== 1) return null; // v1 scope
  const selId = sels[0];
  const isBack = sides[0] === 'back';
  // Best opposite price: a back closes by laying into the best
  // available-to-lay (lowest resting BACK price); a lay closes by backing
  // into the best available-to-back (highest resting LAY price).
  const oppSide = isBack ? 'back' : 'lay';
  const level = db
    .prepare(
      `SELECT price, SUM(stake_cents - matched_cents) AS avail FROM orders
       WHERE selection_id = ? AND side = ? AND status = 'open' AND stake_cents > matched_cents
       GROUP BY price ORDER BY price ${isBack ? 'ASC' : 'DESC'} LIMIT 1`
    )
    .get(selId, oppSide);
  if (!level) return null;
  const n = level.price;
  const S = bets.reduce((a, b) => a + b.stake_cents, 0);
  const numer = bets.reduce((a, b) => a + b.stake_cents * b.price, 0); // Σ s_i·e_i
  const hedgeStake = Math.round(numer / n);
  if (hedgeStake < config.MIN_STAKE_CENTS || hedgeStake > config.MAX_STAKE_CENTS) return null;
  // The self-match guard means the user's OWN resting orders are not
  // executable liquidity, so a quote must not count them.
  const ownAvail = db
    .prepare(
      `SELECT COALESCE(SUM(stake_cents - matched_cents), 0) AS own FROM orders
       WHERE selection_id = ? AND side = ? AND status = 'open' AND user_id = ? AND stake_cents > matched_cents`
    )
    .get(selId, oppSide, user.id).own;
  if (level.avail - ownAvail < hedgeStake) return null;
  // The hedge must be fundable right now, exactly as placeOrderTx will check.
  const me = getUser(db, user.id);
  const escrow = Math.round((n - 1) * hedgeStake);
  if (availableOf(me) < escrow) return null;
  const value = isBack ? hedgeStake - S : S - hedgeStake;
  return {
    selection_id: selId,
    my_side: sides[0],
    hedge_side: isBack ? 'lay' : 'back',
    hedge_price: n,
    hedge_stake_cents: hedgeStake,
    value_cents: value,
  };
}

// Quote only (no execution) — decorates the positions view.
function cashoutQuote(db, user, marketId) {
  return computeCashoutPlan(db, user, marketId);
}

// Execute: hedge order at top of book, all-or-nothing (a partial fill rolls
// back entire — the caller's transaction covers the full-fill check).
function cashoutMarket(db, user, marketId) {
  const plan = computeCashoutPlan(db, user, marketId);
  if (!plan) throw httpError(409, 'Cash-out unavailable (no position / mixed / no liquidity)');
  return transaction(db, () => {
    const { order: hedge, fills } = M.placeOrderTx(db, user, {
      selection_id: plan.selection_id,
      side: plan.hedge_side,
      price: plan.hedge_price,
      stake_cents: plan.hedge_stake_cents,
    });
    if (hedge.matched_cents < plan.hedge_stake_cents) {
      // The hedge partially filled (e.g. the only liquidity was the user's
      // own resting orders, skipped by the self-match guard) — roll it all back.
      throw httpError(409, 'Insufficient liquidity to cash out fully');
    }
    return {
      hedge_order: hedge,
      fills,
      value_cents: plan.value_cents,
      hedge_price: plan.hedge_price,
      my_side: plan.my_side,
    };
  });
}

module.exports = { cashoutQuote, cashoutMarket };
