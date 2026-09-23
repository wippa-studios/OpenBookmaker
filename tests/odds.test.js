// odds.test.js — unit checks for the tick ladder + conversions (PLAN "Odds engine").
// Run: node tests/odds.test.js   (plain assert, no deps)
'use strict';
const assert = require('assert');
const O = require('../lib/odds');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok', name); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// T1: snapToTick is identity on EVERY valid ladder tick (round-trip property).
check('T1 identity on all ladder ticks', () => {
  for (const band of O.LADDER) {
    for (let c = band.lo; c <= band.hi; c += band.step) {
      const p = c / 100;
      assert.strictEqual(O.snapToTick(p), p, `tick ${p}`);
    }
  }
});

// T2: nearest-tick snapping across band boundaries and gaps.
check('T2 nearest-tick snapping', () => {
  assert.strictEqual(O.snapToTick(1.995), 2.0);   // mid-tick, half-up
  assert.strictEqual(O.snapToTick(1.984), 1.98);
  assert.strictEqual(O.snapToTick(3.02), 3.0);    // gap 3.00-3.05: nearer end
  assert.strictEqual(O.snapToTick(3.03), 3.05);
  assert.strictEqual(O.snapToTick(3.04), 3.05);
  assert.strictEqual(O.snapToTick(2.01), 2.0);    // gap tie snaps down
  assert.strictEqual(O.snapToTick(10.2), 10.0);   // gap 10.0-10.5: nearer end
  assert.strictEqual(O.snapToTick(10.3), 10.5);   // gap 10.0-10.5: nearer end
  assert.strictEqual(O.snapToTick(100.01), 100.0);
  assert.strictEqual(O.snapToTick(105.5), 110.0); // gap 100-110: nearer end
});

// T3: clamps to the ladder extremes.
check('T3 clamping', () => {
  assert.strictEqual(O.snapToTick(0.5), 1.01);
  assert.strictEqual(O.snapToTick(5000), 1000);
  assert.strictEqual(O.snapToTick(-3), 1.01);
  assert.strictEqual(O.nextTick(1000), 1000);
  assert.strictEqual(O.prevTick(1.01), 1.01);
});

// T4: next/prev walk band boundaries exactly (2.0→2.02, 10.0→10.5, 100→110...).
check('T4 nextTick/prevTick across bands', () => {
  assert.strictEqual(O.nextTick(1.01), 1.02);
  assert.strictEqual(O.nextTick(2.0), 2.02);
  assert.strictEqual(O.prevTick(2.02), 2.0);
  assert.strictEqual(O.nextTick(3.0), 3.05);
  assert.strictEqual(O.prevTick(3.05), 3.0);
  assert.strictEqual(O.nextTick(6.0), 6.2);
  assert.strictEqual(O.prevTick(6.2), 6.0);
  assert.strictEqual(O.nextTick(10.0), 10.5);
  assert.strictEqual(O.prevTick(10.5), 10.0);
  assert.strictEqual(O.nextTick(20.0), 21.0);
  assert.strictEqual(O.prevTick(21.0), 20.0);
  assert.strictEqual(O.nextTick(30.0), 32.0);
  assert.strictEqual(O.prevTick(32.0), 30.0);
  assert.strictEqual(O.nextTick(50.0), 55.0);
  assert.strictEqual(O.prevTick(55.0), 50.0);
  assert.strictEqual(O.nextTick(100.0), 110.0);
  assert.strictEqual(O.prevTick(110.0), 100.0);
  assert.strictEqual(O.nextTick(2.5), 2.52);
  assert.strictEqual(O.prevTick(2.52), 2.5);
  assert.strictEqual(O.nextTick(1.5), 1.51);
  assert.strictEqual(O.prevTick(1.5), 1.49);
});

// T5: American conversion.
check('T5 toAmerican', () => {
  assert.strictEqual(O.toAmerican(2.5), '+150');
  assert.strictEqual(O.toAmerican(1.5), '-200');
  assert.strictEqual(O.toAmerican(3.0), '+200');
  assert.strictEqual(O.toAmerican(1.25), '-400');
  assert.strictEqual(O.toAmerican(10.0), '+900');
  assert.strictEqual(O.toAmerican(1.01), '-10000');
  assert.strictEqual(O.toAmerican(1.0), null);
  assert.strictEqual(O.toAmerican(0.5), null);
});

// T6: fractional conversion (reduced, denominator ≤ 50).
check('T6 toFractional', () => {
  assert.strictEqual(O.toFractional(2.5), '3/2');
  assert.strictEqual(O.toFractional(3.0), '2/1');
  assert.strictEqual(O.toFractional(1.5), '1/2');
  assert.strictEqual(O.toFractional(2.0), '1/1');
  assert.strictEqual(O.toFractional(1.83), '5/6');
  assert.strictEqual(O.toFractional(1.2), '1/5');
  assert.strictEqual(O.toFractional(1.05), '1/20');
  assert.strictEqual(O.toFractional(1.01), '1/50');
  assert.strictEqual(O.toFractional(6.0), '5/1');
  assert.strictEqual(O.toFractional(4.0), '3/1');
  assert.strictEqual(O.toFractional(1.0), null);
});

// T7: implied probability.
check('T7 impliedProb', () => {
  assert.strictEqual(O.impliedProb(2.0), 0.5);
  assert.strictEqual(O.impliedProb(4.0), 0.25);
  assert.ok(near(O.impliedProb(1.25), 0.8));
});

// T8: overround (book margin).
check('T8 overround', () => {
  assert.ok(near(O.overround([2.0, 3.0, 4.0]), 1 / 12));
  assert.ok(near(O.overround([2.5, 3.4, 2.9]), 0.0389, 1e-3)); // ~3.9% book
  assert.ok(near(O.overround([2.0, 2.0]), 0)); // fair two-way
  assert.ok(O.overround([1.01, 1.01]) > 0.9);
});

// T9: validTick discriminator.
check('T9 validTick', () => {
  assert.strictEqual(O.validTick(2.02), true);
  assert.strictEqual(O.validTick(1.01), true);
  assert.strictEqual(O.validTick(2.01), false);
  assert.strictEqual(O.validTick(3.03), false);
  assert.strictEqual(O.validTick(0.5), false);
  assert.strictEqual(O.validTick(1000.01), false);
  assert.strictEqual(O.validTick(1000), true);
});

// T10: next/prev never leave the ladder range for arbitrary inputs.
check('T10 range safety', () => {
  for (let c = 50; c <= 100200; c += 137) {
    const p = O.snapToTick(c / 100);
    assert.ok(p >= 1.01 && p <= 1000, `range at ${c}`);
    assert.strictEqual(O.validTick(p), true, `valid at ${c}`);
  }
});

console.log(`\nodds.test.js: ${passed} checks passed`);
