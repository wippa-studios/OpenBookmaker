'use strict';
// lib/bots.js — MarketMakers liquidity bot: quotes a ~3-tick spread around
// each selection's fair price so the exchange is always tradeable, even with
// no other users. Bot orders are ordinary rows; the engine treats all users
// identically (self-match guard keeps the bot's own two sides apart).
const A = require('./auth');
const M = require('./match');
const { release } = require('./ledger');
const { transaction } = require('./tx');
const { nextTick, prevTick } = require('./odds');

function ensureBot(db) {
  let bot = db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
  if (!bot) {
    A.registerUser(db, {
      username: 'MarketMakers',
      password: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      is_bot: 1,
      balance_cents: 100000000, // $1M paper bank
    });
    bot = db.prepare('SELECT * FROM users WHERE is_bot = 1 ORDER BY id LIMIT 1').get();
  }
  return bot;
}

function size() {
  return 3000 + Math.floor(Math.random() * 17000); // $30-$200 per level
}

function ticksAway(price, k, up) {
  let p = price;
  for (let i = 0; i < k; i++) p = up ? nextTick(p) : prevTick(p);
  return p;
}

// Requote ONE market's bot ladders around the current fair prices
// (cancel + replace, so bots follow drift without crossing the spread).
function quoteMarket(db, marketId) {
  const bot = ensureBot(db);
  const sels = db
    .prepare("SELECT * FROM selections WHERE market_id = ? AND status = 'open' AND fair_price IS NOT NULL")
    .all(marketId);
  transaction(db, () => {
    const open = db
      .prepare("SELECT * FROM orders WHERE user_id = ? AND market_id = ? AND status = 'open'")
      .all(bot.id, marketId);
    for (const o of open) {
      const remainder = o.stake_cents - o.matched_cents;
      const esc = o.side === 'back' ? remainder : Math.round((o.price - 1) * remainder);
      if (esc > 0) release(db, o.user_id, esc, { orderId: o.id, marketId });
      db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(o.id);
    }
    for (const sel of sels) {
      const F = sel.fair_price;
      // Lay offers (available to back) ABOVE fair: users back into them.
      for (let k = 1; k <= 3; k++) {
        M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'lay', price: ticksAway(F, k, true), stake_cents: size() });
      }
      // Back offers (available to lay) BELOW fair: users lay into them.
      for (let k = 1; k <= 3; k++) {
        M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'back', price: ticksAway(F, k, false), stake_cents: size() });
      }
    }
  });
}

// Requote ONE selection's bot ladders around its current fair price
// (cancel + replace). Used by the drift loop so a single price move does not
// churn every order in the market.
function requoteSelection(db, selectionId) {
  const sel = db.prepare("SELECT * FROM selections WHERE id = ? AND status = 'open' AND fair_price IS NOT NULL").get(selectionId);
  if (!sel) return;
  const bot = ensureBot(db);
  const marketId = sel.market_id;
  const market = db.prepare('SELECT status FROM markets WHERE id = ?').get(marketId);
  if (!market || market.status !== 'open') return;
  transaction(db, () => {
    const open = db
      .prepare("SELECT * FROM orders WHERE user_id = ? AND selection_id = ? AND status = 'open'")
      .all(bot.id, selectionId);
    for (const o of open) {
      const remainder = o.stake_cents - o.matched_cents;
      const esc = o.side === 'back' ? remainder : Math.round((o.price - 1) * remainder);
      if (esc > 0) release(db, o.user_id, esc, { orderId: o.id, marketId });
      db.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(o.id);
    }
    const F = sel.fair_price;
    for (let k = 1; k <= 3; k++) {
      M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'lay', price: ticksAway(F, k, true), stake_cents: size() });
    }
    for (let k = 1; k <= 3; k++) {
      M.placeOrderTx(db, bot, { selection_id: sel.id, side: 'back', price: ticksAway(F, k, false), stake_cents: size() });
    }
  });
}

function quoteAllMarkets(db) {
  const markets = db.prepare("SELECT id FROM markets WHERE status = 'open'").all();
  for (const m of markets) quoteMarket(db, m.id);
}

module.exports = { quoteMarket, requoteSelection, quoteAllMarkets };
