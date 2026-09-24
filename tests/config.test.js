// config.test.js — env validation, loopback-only binding, path resolution.
// Run: node tests/config.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const { loadConfig } = require('../lib/config');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };
const load = (over) => loadConfig('/nonexistent/.env', over);

// C1: defaults.
check('C1 defaults', () => {
  const c = load();
  assert.strictEqual(c.PORT, 7777);
  assert.strictEqual(c.HOST, '127.0.0.1');
  assert.strictEqual(c.COMMISSION_RATE, 0.025);
  assert.strictEqual(c.MIN_STAKE_CENTS, 100);
  assert.strictEqual(c.MAX_STAKE_CENTS, 100000);
  assert.strictEqual(c.DRIFT_ENABLED, true);
});

// C2: loopback-only binding — a routable interface must abort the launch.
check('C2 loopback-only HOST', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.strictEqual(load({ HOST: host }).HOST, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
    assert.throws(() => load({ HOST: host }), /HOST must be a loopback address/);
  }
  // An empty HOST is not an exposure: it falls back to the loopback default.
  assert.strictEqual(load({ HOST: '' }).HOST, '127.0.0.1');
  assert.strictEqual(load({ HOST: '   ' }).HOST, '127.0.0.1');
});

// C3: numeric ranges abort with a clear message instead of failing later.
check('C3 numeric validation', () => {
  assert.throws(() => load({ PORT: 'abc' }), /PORT must be an integer/);
  assert.throws(() => load({ PORT: 0 }), /PORT must be an integer/);
  assert.throws(() => load({ PORT: 70000 }), /PORT must be an integer/);
  assert.throws(() => load({ COMMISSION_RATE: 0.5 }), /COMMISSION_RATE/);
  assert.throws(() => load({ COMMISSION_RATE: -0.1 }), /COMMISSION_RATE/);
  assert.throws(() => load({ MIN_STAKE_CENTS: 500, MAX_STAKE_CENTS: 100 }), /MAX_STAKE_CENTS/);
  assert.throws(() => load({ SESSION_TTL_DAYS: 0 }), /SESSION_TTL_DAYS/);
  assert.throws(() => load({ DRIFT_INTERVAL_MS: 10 }), /DRIFT_INTERVAL_MS/);
});

// C4: booleans accept only real booleans / 'true' / 'false'.
check('C4 boolean validation', () => {
  assert.strictEqual(load({ DRIFT_ENABLED: 'false' }).DRIFT_ENABLED, false);
  assert.strictEqual(load({ BOT_ENABLED: 'true' }).BOT_ENABLED, true);
  assert.strictEqual(load({ BOT_ENABLED: false }).BOT_ENABLED, false);
  assert.throws(() => load({ DRIFT_ENABLED: 'yes' }), /DRIFT_ENABLED/);
  assert.throws(() => load({ BOT_ENABLED: 1 }), /BOT_ENABLED/);
});

// C5: DB_PATH resolves against the project root; ':memory:' stays special.
check('C5 DB_PATH resolution', () => {
  assert.ok(load({ DB_PATH: ':memory:' }).DB_PATH === ':memory:');
  const c = load({ DB_PATH: 'data/x.db' });
  assert.ok(c.DB_PATH.endsWith('/OpenBookmaker/data/x.db'), c.DB_PATH);
  const abs = load({ DB_PATH: '/tmp/abs.db' });
  assert.strictEqual(abs.DB_PATH, '/tmp/abs.db');
});

console.log(`\nconfig.test.js: ${passed} checks passed`);
