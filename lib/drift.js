'use strict';
// lib/drift.js — gentle random-walk repricing of open selections so the
// exchange feels live without a trader sitting at the desk. The FAIR price
// moves (the bot's view); LTP only ever moves on real trades. Off in tests
// (DRIFT_ENABLED=false).
const { nextTick, prevTick } = require('./odds');
const bots = require('./bots');

function tick(db, broadcast) {
  try {
    const sel = db
      .prepare(
        `SELECT s.* FROM selections s JOIN markets m ON m.id = s.market_id
         WHERE m.status = 'open' AND s.status = 'open' AND s.fair_price IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`
      )
      .get();
    if (!sel) return;
    const p = sel.fair_price;
    // Random walk, clamped at the ladder extremes.
    const up = p <= 1.02 ? true : p >= 990 ? false : Math.random() < 0.5;
    const next = up ? nextTick(p) : prevTick(p);
    if (next !== p) {
      db.prepare('UPDATE selections SET fair_price = ? WHERE id = ?').run(next, sel.id);
      // Only the moved runner's ladders are requoted (keeps the order churn
      // proportional to one price move, not to the size of the market).
      bots.requoteSelection(db, sel.id);
      if (broadcast) broadcast('book', { market_id: sel.market_id });
    }
  } catch (e) {
    console.error('[drift]', e.message);
  }
}

function startDrift(db, { intervalMs = 5000, broadcast = null } = {}) {
  const timer = setInterval(() => tick(db, broadcast), intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { startDrift, tick };
