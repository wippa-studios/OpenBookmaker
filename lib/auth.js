'use strict';
// lib/auth.js — scrypt password hashing + opaque DB session tokens.
// Users never leave this module with a pass_hash. Errors carry a .status
// property for the server's error handler.
const crypto = require('node:crypto');
const config = require('./config');

// scrypt with per-hash random salt, stored as one string:
//   scrypt$<salt hex>$<hash hex>
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

// Shape returned to the browser — NEVER includes pass_hash.
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    is_admin: !!row.is_admin,
    is_bot: !!row.is_bot,
    balance_cents: row.balance_cents,
    frozen_cents: row.frozen_cents,
  };
}

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    throw httpError(400, 'Username must be 3-32 chars (letters, digits, _ or -)');
  }
  const pw = String(password || '');
  if (pw.length < 6 || pw.length > 128) {
    throw httpError(400, 'Password must be 6-128 chars');
  }
}

function registerUser(db, { username, password, is_admin = 0, is_bot = 0, balance_cents = 0 }) {
  validateCredentials(username, password);
  // Money boundary: integer cents, never negative. A fractional or negative
  // opening balance would break the settlement conservation invariant.
  const start = Number(balance_cents);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw httpError(400, 'Opening balance must be a non-negative integer number of cents');
  }
  const name = String(username).trim();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) throw httpError(409, 'Username already taken');
  const info = db
    .prepare('INSERT INTO users (username, pass_hash, is_admin, is_bot, balance_cents) VALUES (?, ?, ?, ?, ?)')
    .run(name, hashPassword(password), is_admin ? 1 : 0, is_bot ? 1 : 0, start);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return sanitizeUser(row);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token);
  return sanitizeUser(row);
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// A fixed dummy hash (salt+hash of a random value) is verified when the
// username does not exist, so a missing user costs the same scrypt work as a
// wrong password and cannot be told apart by timing.
let dummyHash = null;
function dummyVerify() {
  if (!dummyHash) dummyHash = hashPassword('dummy-password-for-constant-work');
  verifyPassword('not-the-password', dummyHash);
}

function loginUser(db, { username, password }) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row) {
    dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  if (!verifyPassword(password, row.pass_hash)) {
    throw httpError(401, 'Invalid username or password');
  }
  if (row.is_bot) {
    dummyVerify();
    throw httpError(401, 'Invalid username or password');
  }
  const token = createSession(db, row.id);
  return { user: sanitizeUser(row), token };
}

module.exports = {
  httpError,
  hashPassword,
  verifyPassword,
  sanitizeUser,
  registerUser,
  createSession,
  sessionUser,
  destroySession,
  loginUser,
};
