'use strict';
// lib/ledger.js — wallet movements with full integrity.
// Money is integer cents. users.balance_cents = TOTAL funds (incl. frozen);
// users.frozen_cents = escrow. available = balance − frozen.
//
// Every movement writes a transactions row with balance_after + frozen_after.
// Ops are wrapped in SAVEPOINTs (not BEGIN) so they compose cleanly inside a
// caller's outer transaction — a SAVEPOINT outside a transaction still acts
// as one, and ROLLBACK TO + RELEASE nests correctly either way.
const { httpError } = require('./auth');

const TX_TYPES = new Set(['deposit', 'escrow', 'release', 'settle', 'commission', 'refund']);

function getUser(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw httpError(404, 'User not found');
  return u;
}

function availableOf(u) {
  return u.balance_cents - u.frozen_cents;
}

function insertTx(db, userId, type, amountCents, balanceAfter, frozenAfter, ref) {
  db.prepare(
    `INSERT INTO transactions (user_id, type, amount_cents, balance_after, frozen_after, order_id, market_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    type,
    amountCents,
    balanceAfter,
    frozenAfter,
    ref.orderId ?? null,
    ref.marketId ?? null
  );
}

// Faucet deposit (paper money). Cap enforced per deposit.
function deposit(db, userId, cents, capCents) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Deposit must be a positive integer amount of cents');
  }
  if (!Number.isInteger(capCents) || capCents <= 0) {
    throw httpError(400, 'Faucet cap misconfigured');
  }
  if (cents > capCents) {
    throw httpError(400, `Deposit exceeds the faucet cap of $${(capCents / 100).toFixed(2)}`);
  }
  db.exec('SAVEPOINT ledger_op');
  try {
    const u = getUser(db, userId);
    const bal = u.balance_cents + cents;
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(bal, userId);
    insertTx(db, userId, 'deposit', cents, bal, u.frozen_cents, {});
    db.exec('RELEASE SAVEPOINT ledger_op');
    return { balance_cents: bal, frozen_cents: u.frozen_cents };
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT ledger_op');
    db.exec('RELEASE SAVEPOINT ledger_op');
    throw e;
  }
}

// Freeze escrow (order placement / matched pot). Refuses to over-commit
// available funds.
function escrow(db, userId, cents, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Escrow must be a positive integer amount of cents');
  }
  db.exec('SAVEPOINT ledger_op');
  try {
    const u = getUser(db, userId);
    if (availableOf(u) < cents) {
      throw httpError(400, 'Insufficient available balance');
    }
    const fro = u.frozen_cents + cents;
    db.prepare('UPDATE users SET frozen_cents = ? WHERE id = ?').run(fro, userId);
    insertTx(db, userId, 'escrow', cents, u.balance_cents, fro, ref);
    db.exec('RELEASE SAVEPOINT ledger_op');
    return { balance_cents: u.balance_cents, frozen_cents: fro };
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT ledger_op');
    db.exec('RELEASE SAVEPOINT ledger_op');
    throw e;
  }
}

// Unfreeze (cancel remainder / lay excess release / auto-cancel at settle).
function release(db, userId, cents, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw httpError(400, 'Release must be a positive integer amount of cents');
  }
  db.exec('SAVEPOINT ledger_op');
  try {
    const u = getUser(db, userId);
    if (u.frozen_cents < cents) {
      throw httpError(400, 'Cannot release more than is frozen');
    }
    const fro = u.frozen_cents - cents;
    db.prepare('UPDATE users SET frozen_cents = ? WHERE id = ?').run(fro, userId);
    insertTx(db, userId, 'release', cents, u.balance_cents, fro, ref);
    db.exec('RELEASE SAVEPOINT ledger_op');
    return { balance_cents: u.balance_cents, frozen_cents: fro };
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT ledger_op');
    db.exec('RELEASE SAVEPOINT ledger_op');
    throw e;
  }
}

// Settlement for ONE user on ONE market, atomic:
//   balance += balanceDelta − commissionCents
//   frozen −= frozenRelease
//   rows: refund (void refunds), settle (net, may be negative = loss),
//         commission (fee, only when > 0).
function settleUser(db, userId, { balanceDelta, frozenRelease, commissionCents = 0, refundCents = 0, marketId = null }) {
  if (!Number.isInteger(balanceDelta)) {
    throw httpError(400, 'Settlement balanceDelta must be an integer (cents)');
  }
  if (!Number.isInteger(frozenRelease) || frozenRelease < 0) {
    throw httpError(400, 'Settlement frozenRelease must be a non-negative integer (cents)');
  }
  if (!Number.isInteger(commissionCents) || commissionCents < 0) {
    throw httpError(400, 'Commission must be a non-negative integer (cents)');
  }
  if (!Number.isInteger(refundCents) || refundCents < 0) {
    throw httpError(400, 'Refund must be a non-negative integer (cents)');
  }
  db.exec('SAVEPOINT ledger_op');
  try {
    const u = getUser(db, userId);
    if (u.frozen_cents < frozenRelease) {
      throw httpError(500, 'Settlement integrity error: releasing more than frozen');
    }
    const bal = u.balance_cents + balanceDelta - commissionCents;
    if (bal < 0) {
      throw httpError(500, 'Settlement integrity error: negative balance');
    }
    const fro = u.frozen_cents - frozenRelease;
    db.prepare('UPDATE users SET balance_cents = ?, frozen_cents = ? WHERE id = ?').run(bal, fro, userId);
    if (refundCents > 0) {
      insertTx(db, userId, 'refund', refundCents, bal, fro, { marketId });
    } else if (balanceDelta !== 0) {
      insertTx(db, userId, 'settle', balanceDelta, bal, fro, { marketId });
    }
    if (commissionCents > 0) {
      insertTx(db, userId, 'commission', commissionCents, bal, fro, { marketId });
    }
    db.exec('RELEASE SAVEPOINT ledger_op');
    return { balance_cents: bal, frozen_cents: fro };
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT ledger_op');
    db.exec('RELEASE SAVEPOINT ledger_op');
    throw e;
  }
}

// Wallet view for the server: balance split + recent transactions.
function walletView(db, userId, limit = 100) {
  const u = getUser(db, userId);
  const txs = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
  return {
    balance_cents: u.balance_cents,
    frozen_cents: u.frozen_cents,
    available_cents: availableOf(u),
    transactions: txs,
  };
}

module.exports = {
  TX_TYPES,
  getUser,
  availableOf,
  deposit,
  escrow,
  release,
  settleUser,
  walletView,
};
