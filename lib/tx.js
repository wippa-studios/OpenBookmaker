'use strict';
// lib/tx.js — the single way this codebase opens a transaction.
//
// SQLite has no nested BEGIN and node:sqlite exposes no inTransaction()
// introspection, so this module owns the depth: the outermost call issues
// BEGIN/COMMIT and any nested call (a ledger op inside settleMarket, say)
// uses a SAVEPOINT instead. Every money-moving unit of work goes through
// here, which is what makes "all-or-nothing" a property of the code rather
// than a convention someone has to remember.
//
// Depth is per-process, not per-connection: this app drives one connection,
// and the test suite opens one database per process.
let depth = 0;

function inTransaction() {
  return depth > 0;
}

function transaction(db, fn) {
  if (depth > 0) {
    const sp = `sp_tx_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    depth += 1;
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      throw e;
    } finally {
      depth -= 1;
    }
  }
  db.exec('BEGIN');
  depth = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth = 0;
  }
}

module.exports = { transaction, inTransaction };
