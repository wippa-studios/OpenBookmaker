// auth.test.js — scrypt hashing, registration, sessions (PLAN "Auth").
// Run: node tests/auth.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { openStore } = require('../lib/store');
const A = require('../lib/auth');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };

function fresh() {
  return openStore(':memory:');
}

// A1: hash/verify roundtrip; wrong password fails; garbage stored hash fails safely.
check('A1 password hashing', () => {
  const db = fresh();
  const h = A.hashPassword('hunter22');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(A.verifyPassword('hunter22', h));
  assert.ok(!A.verifyPassword('hunter23', h));
  assert.ok(!A.verifyPassword('hunter22', 'garbage'));
  assert.ok(!A.verifyPassword('hunter22', 'md5$abc$def'));
  assert.ok(!A.verifyPassword('hunter22', 'scrypt$$'));
});

// A2: register → sanitized user (no pass_hash), starting balance; duplicate rejected.
check('A2 registration', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 50000 });
  assert.strictEqual(u.username, 'joel');
  assert.strictEqual(u.balance_cents, 50000);
  assert.strictEqual(u.is_admin, false);
  assert.strictEqual(u.pass_hash, undefined);
  assert.throws(() => A.registerUser(db, { username: 'joel', password: 'secret2' }), (e) => e.status === 409);
});

// A3: credential validation (400).
check('A3 validation', () => {
  const db = fresh();
  assert.throws(() => A.registerUser(db, { username: 'ab', password: 'secret1' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'bad name!', password: 'secret1' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'okname', password: '12345' }), (e) => e.status === 400);
  assert.throws(() => A.registerUser(db, { username: 'okname', password: '' }), (e) => e.status === 400);
});

// A4: login → token + user; wrong password and unknown user share ONE generic error.
check('A4 login', () => {
  const db = fresh();
  A.registerUser(db, { username: 'joel', password: 'secret1', balance_cents: 1000 });
  const { user, token } = A.loginUser(db, { username: 'joel', password: 'secret1' });
  assert.strictEqual(user.username, 'joel');
  assert.ok(/^[0-9a-f]{64}$/.test(token));
  let msgWrong = null;
  let msgUnknown = null;
  try { A.loginUser(db, { username: 'joel', password: 'wrongpw' }); } catch (e) { msgWrong = e.message; }
  try { A.loginUser(db, { username: 'ghost', password: 'wrongpw' }); } catch (e) { msgUnknown = e.message; }
  assert.strictEqual(msgWrong, 'Invalid username or password');
  assert.strictEqual(msgUnknown, msgWrong);
});

// A5: sessions — valid resolves, expired is dead, logout deletes.
check('A5 sessions', () => {
  const db = fresh();
  const u = A.registerUser(db, { username: 'joel', password: 'secret1' });
  const token = A.createSession(db, u.id);
  assert.strictEqual(A.sessionUser(db, token).username, 'joel');
  // expired session (insert one in the past directly)
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('dead', ?, datetime('now', '-1 day'))").run(u.id);
  assert.strictEqual(A.sessionUser(db, 'dead'), null);
  // logout
  A.destroySession(db, token);
  assert.strictEqual(A.sessionUser(db, token), null);
  assert.strictEqual(A.sessionUser(db, null), null);
});

// A6: bots can never log in (they hold random passwords; explicit guard too).
check('A6 bot login rejected', () => {
  const db = fresh();
  A.registerUser(db, { username: 'MarketMakers', password: 'botpw123', is_bot: 1 });
  assert.throws(() => A.loginUser(db, { username: 'MarketMakers', password: 'botpw123' }), (e) => e.status === 401);
});

console.log(`\nauth.test.js: ${passed} checks passed`);
