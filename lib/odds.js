'use strict';
// lib/odds.js — Betfair-style tick ladder + odds format conversions.
// Pure functions, no I/O. Prices are decimal odds (2dp); handled in integer
// cents internally so band arithmetic never sees float drift.
//
// Ladder (Betfair classic):
//   1.01-2.00 step .01 | 2.02-3.00 step .02 | 3.05-4.00 step .05
//   4.10-6.00 step .10 | 6.20-10.0 step .20 | 10.5-20   step .5
//   21-30  step 1 | 32-50 step 2 | 55-100 step 5 | 110-1000 step 10

const LADDER = [
  { lo: 101, hi: 200, step: 1 },         // 1.01-2.00 step 0.01
  { lo: 202, hi: 300, step: 2 },         // 2.02-3.00 step 0.02
  { lo: 305, hi: 400, step: 5 },         // 3.05-4.00 step 0.05
  { lo: 410, hi: 600, step: 10 },        // 4.10-6.00 step 0.10
  { lo: 620, hi: 1000, step: 20 },       // 6.20-10.0 step 0.20
  { lo: 1050, hi: 2000, step: 50 },      // 10.5-20   step 0.5
  { lo: 2100, hi: 3000, step: 100 },     // 21-30     step 1
  { lo: 3200, hi: 5000, step: 200 },     // 32-50     step 2
  { lo: 5500, hi: 10000, step: 500 },    // 55-100    step 5
  { lo: 11000, hi: 100000, step: 1000 }, // 110-1000  step 10
];

const MIN_PRICE_CENTS = 101; // 1.01
const MAX_PRICE_CENTS = 100000; // 1000.0

function priceToCents(p) {
  return Math.round(Number(p) * 100);
}

// Integer cents ≤ 100000 divided by 100 give the same double as the 2dp literal.
function centsToPrice(c) {
  return c / 100;
}

function bandFor(cents) {
  for (const band of LADDER) {
    if (cents >= band.lo && cents <= band.hi) return band;
  }
  return null;
}

// Clamp to [1.01, 1000] and round to the nearest valid ladder tick. Prices in
// the gaps between bands snap to the nearer end (ties snap down).
function snapToTick(p) {
  let c = priceToCents(p);
  if (c < MIN_PRICE_CENTS) c = MIN_PRICE_CENTS;
  if (c > MAX_PRICE_CENTS) c = MAX_PRICE_CENTS;
  const band = bandFor(c);
  if (band) {
    const maxIdx = Math.round((band.hi - band.lo) / band.step);
    let idx = Math.round((c - band.lo) / band.step);
    if (idx < 0) idx = 0;
    if (idx > maxIdx) idx = maxIdx;
    return centsToPrice(band.lo + idx * band.step);
  }
  let below = null;
  let above = null;
  for (const b of LADDER) {
    if (b.hi < c) below = b.hi;
    if (above === null && b.lo > c) above = b.lo;
  }
  if (below === null) return centsToPrice(MIN_PRICE_CENTS);
  if (above === null) return centsToPrice(MAX_PRICE_CENTS);
  return centsToPrice((c - below) <= (above - c) ? below : above);
}

function nextTick(p) {
  const c = priceToCents(snapToTick(p));
  const band = bandFor(c);
  if (!band) return centsToPrice(MAX_PRICE_CENTS);
  const maxIdx = Math.round((band.hi - band.lo) / band.step);
  const idx = Math.round((c - band.lo) / band.step);
  if (idx < maxIdx) return centsToPrice(c + band.step);
  const bIdx = LADDER.indexOf(band);
  if (bIdx === LADDER.length - 1) return centsToPrice(MAX_PRICE_CENTS); // clamp at 1000
  return centsToPrice(LADDER[bIdx + 1].lo);
}

function prevTick(p) {
  const c = priceToCents(snapToTick(p));
  const band = bandFor(c);
  if (!band) return centsToPrice(MIN_PRICE_CENTS);
  const idx = Math.round((c - band.lo) / band.step);
  if (idx > 0) return centsToPrice(c - band.step);
  const bIdx = LADDER.indexOf(band);
  if (bIdx === 0) return centsToPrice(MIN_PRICE_CENTS); // clamp at 1.01
  return centsToPrice(LADDER[bIdx - 1].hi);
}

// Is p exactly on the ladder?
function validTick(p) {
  const c = priceToCents(p);
  if (c < MIN_PRICE_CENTS || c > MAX_PRICE_CENTS) return false;
  const band = bandFor(c);
  if (!band) return false;
  return (c - band.lo) % band.step === 0;
}

// Decimal → American ("+150" / "-200"); null for odds ≤ 1.
function toAmerican(p) {
  if (!(Number(p) > 1)) return null;
  if (p >= 2) return '+' + Math.round((p - 1) * 100);
  return '-' + Math.round(100 / (p - 1));
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

// Decimal → reduced fractional ("3/2"); approximate with denominator ≤ 50
// (documented approximation for extreme prices). Among near-best
// approximations the simplest fraction wins (bookmaker convention: 5/6 over
// 39/47 for 1.83). Null for odds ≤ 1.
function toFractional(p) {
  if (!(Number(p) > 1)) return null;
  const target = p - 1;
  const candidates = [];
  for (let d = 1; d <= 50; d++) {
    const n = Math.round(target * d);
    if (n === 0) continue; // never collapse a real price to "0/1"
    candidates.push({ n, d, err: Math.abs(target - n / d) });
  }
  if (!candidates.length) return '1/1';
  let bestErr = Infinity;
  for (const c of candidates) {
    if (c.err < bestErr) bestErr = c.err;
  }
  const EPS = 1e-9;
  const exact = candidates.filter((c) => c.err <= EPS);
  let pick;
  if (exact.length) {
    // An exact fraction exists (e.g. 1.05 = 1/20) — smallest denominator wins.
    pick = exact.reduce((m, c) => (c.d < m.d ? c : m), exact[0]);
  } else {
    const tol = 0.005; // near-best tolerance for the simplicity preference
    const eligible = candidates.filter((c) => c.err <= bestErr + tol);
    pick = eligible.reduce((m, c) => (c.d < m.d ? c : m), eligible[0]);
  }
  const g = gcd(pick.n, pick.d) || 1;
  return `${pick.n / g}/${pick.d / g}`;
}

// Implied probability of a decimal price.
function impliedProb(p) {
  return 1 / p;
}

// Overround (book margin) of a set of decimal prices: Σ(1/pᵢ) − 1.
function overround(prices) {
  let s = 0;
  for (const p of prices) s += 1 / p;
  return s - 1;
}

module.exports = {
  LADDER,
  MIN_PRICE_CENTS,
  MAX_PRICE_CENTS,
  priceToCents,
  centsToPrice,
  bandFor,
  snapToTick,
  nextTick,
  prevTick,
  validTick,
  toAmerican,
  toFractional,
  impliedProb,
  overround,
};
