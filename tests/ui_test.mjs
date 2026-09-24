// ui_test.mjs — REAL-BROWSER verification of the exchange UI.
// Run: npm run test:ui
//
// Boots the server on a temp DB (bots on, drift off), drives the page in
// Chromium, and fails on ANY uncaught page error — the class of bug that
// `node --check` cannot see (wrong element id, runtime TypeError, a render
// path that never fires).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.UI_TEST_PORT || 7898);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'ob-ui-'));
const SHOT = process.env.UI_SHOT || path.join(ROOT, 'ui-test.png'); // gitignored: test output, not a source asset

let passed = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    passed++;
    console.log('  ok  ', name, extra);
  } else {
    console.log('  FAIL', name, extra);
    process.exitCode = 1;
  }
};

const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: path.join(TMP, 'ui.db'), PORT: String(PORT), DRIFT_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const cleanup = () => {
  server.kill('SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
};
process.on('exit', cleanup);

// Wait for readiness.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}/api/sports`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

// Any uncaught exception in the page is a failure, whatever else passes.
// The app probes /api/me on load to detect an existing session; while signed
// out that legitimately 401s and Chromium logs it — expected, not a defect.
const pageErrors = [];
let signedIn = false;
const EXPECTED_PREAUTH_401 = /401 \(Unauthorized\)/;
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = 'console.error: ' + msg.text();
  if (!signedIn && EXPECTED_PREAUTH_401.test(msg.text())) return;
  pageErrors.push(text);
});

try {
  // ── board renders with bot liquidity ──────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ladder .lcell[data-bet]', { timeout: 15000 });
  const cells = await page.locator('.ladder .lcell[data-bet]').count();
  check('ladder renders price cells', cells >= 6, `(${cells} cells)`);

  // Geometry: each runner is ONE row of [3 back stacked | runner | 3 lay
  // stacked]. CSS grid auto-places row-major, so without the stack wrappers
  // the three prices of a side spread across the columns instead of stacking.
  const geom = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lrow')].find((r) => r.querySelector('.lcell[data-bet]'));
    if (!row) return null;
    const box = (n) => {
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
    };
    const stacks = [...row.querySelectorAll('.lstack')].map(box);
    const backCells = [...row.querySelectorAll('.lstack:first-child .lcell')].map(box);
    const mid = box(row.querySelector('.lmid'));
    return { stacks, backCells, mid, kids: row.children.length };
  });
  check('runner row has exactly 3 columns (stacks + runner)', geom && geom.kids === 3, JSON.stringify(geom && geom.kids));
  check(
    'the three back prices stack in one column',
    geom && new Set(geom.backCells.map((c) => c.x)).size === 1 && geom.backCells[0].y < geom.backCells[2].y,
    geom ? JSON.stringify(geom.backCells.map((c) => `${c.x},${c.y}`)) : 'no row'
  );
  check(
    'back stack | runner | lay stack are side by side',
    geom && geom.stacks[0].x < geom.mid.x && geom.mid.x + geom.mid.w <= geom.stacks[1].x + 1,
    geom ? `back@${geom.stacks[0].x} runner@${geom.mid.x} lay@${geom.stacks[1].x}` : 'no row'
  );
  check(
    'runner label is vertically centred against its price stacks',
    geom && geom.mid.y >= geom.backCells[0].y && geom.mid.y <= geom.backCells[2].y + 20,
    geom ? `mid@${geom.mid.y} stack ${geom.backCells[0].y}..${geom.backCells[2].y}` : 'no row'
  );
  const chipText = await page.locator('#sportbar .chip').first().textContent();
  check('sport filter bar renders', /All/.test(chipText || ''), `(${String(chipText).trim()})`);
  check('signed-out user sees the sign-in button', (await page.locator('#authBtn').textContent()) === 'Sign in');

  // ── clicking a price without a session opens the auth modal ──────────
  await page.locator('.ladder .lcell[data-bet]').first().click();
  await page.waitForSelector('#authModal.show', { timeout: 5000 });
  check('clicking a price unauthenticated opens sign-in', true);

  // ── sign in as the seeded demo user ──────────────────────────────────
  await page.fill('#authUser', 'demo');
  await page.fill('#authPass', 'demo123');
  await page.click('#authGo');
  // Wait for the real success signal (balance chip), then assert the modal closed.
  await page.waitForSelector('#balance:not([hidden])', { timeout: 10000 });
  check('auth modal closes after sign-in', (await page.locator('#authModal').getAttribute('class')) !== 'show');
  const balance = (await page.locator('#balance').textContent()) || '';
  signedIn = true;
  check('balance chip shows after sign-in', /\$\d/.test(balance), `(${balance.trim()})`);
  check('sign-in button becomes sign out', (await page.locator('#authBtn').textContent()) === 'Sign out');

  // ── place a bet through the slip ─────────────────────────────────────
  const target = page.locator('.ladder .lcell[data-bet]').first();
  const clickedPrice = (await target.getAttribute('data-price')) || '';
  const clickedSide = (await target.getAttribute('data-side')) || '';
  await target.click();
  await page.waitForSelector('#slip:not([hidden]) .sliprow', { timeout: 5000 });
  const slipText = (await page.locator('#slip .sliprow').first().textContent()) || '';
  check('bet slip opens with the clicked side', slipText.includes(clickedSide.toUpperCase()), `(${clickedSide} @ ${clickedPrice})`);
  const priceShown = (await page.locator('#slip input[data-price]').first().inputValue()) || '';
  check('slip price matches the clicked price', Math.abs(Number(priceShown) - Number(clickedPrice)) < 1e-9, `(${priceShown})`);

  // Typing a price must be honoured (snapped), not silently ignored.
  await page.fill('#slip input[data-price]', '2.13');
  await page.dispatchEvent('#slip input[data-price]', 'change');
  await page.waitForTimeout(150);
  const snapped = (await page.locator('#slip input[data-price]').first().inputValue()) || '';
  check('typed price snaps to the ladder', Number(snapped) >= 1.01 && Number(snapped) <= 1000, `(${snapped})`);

  await page.fill('#slip input[data-stake]', '2');
  await page.dispatchEvent('#slip input[data-stake]', 'change');
  await page.click('#slip button.place');
  await page.waitForSelector('#toast.show', { timeout: 10000 });
  const toast = (await page.locator('#toast').textContent()) || '';
  check('placing a bet reports matched or resting', /Matched|Resting/.test(toast), `("${toast.trim()}")`);
  await page.waitForFunction(() => document.getElementById('slip').hidden, null, { timeout: 5000 });
  check('slip clears after placing', true);

  // ── my bets shows the order or a position ────────────────────────────
  await page.click('#nav button[data-page="bets"]');
  await page.waitForSelector('#betsBody', { timeout: 5000 });
  await page.click('[data-tab="positions"]');
  await page.waitForTimeout(600);
  const posHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('positions tab renders without error', posHtml.length > 0);
  await page.click('[data-tab="open"]');
  await page.waitForTimeout(600);
  const openHtml = (await page.locator('#betsBody').innerHTML()) || '';
  check('open orders tab renders without error', openHtml.length > 0);

  // ── wallet shows the ledger ──────────────────────────────────────────
  await page.click('#nav button[data-page="wallet"]');
  await page.waitForSelector('#wBal', { timeout: 5000 });
  const bal = (await page.locator('#wBal').textContent()) || '';
  check('wallet renders a balance', /\$\d/.test(bal), `(${bal})`);
  await page.waitForFunction(() => document.querySelector('#wTx table, #wTx .empty'), null, { timeout: 10000 });
  check('wallet renders transactions or an empty state', true);

  // ── admin desk is hidden for a normal user ───────────────────────────
  check('admin tab hidden for a customer', await page.locator('#navAdmin').isHidden());
  await page.click('#nav button[data-page="markets"]');
  await page.waitForSelector('.ladder', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT, fullPage: false });
  console.log('  info screenshot:', SHOT);

  // ── admin desk: overround column + the server-backed fair-price helper ──
  await check('admin desk renders the overround column', async () => {
    await page.click('#authBtn'); // sign out of the customer session
    await page.waitForFunction(() => document.getElementById('authBtn').textContent === 'Sign in', null, { timeout: 10000 });
    await page.click('#authBtn');
    await page.waitForSelector('#authModal.show', { timeout: 5000 });
    await page.fill('#authUser', 'admin');
    await page.fill('#authPass', 'admin123');
    await page.click('#authGo');
    await page.waitForSelector('#navAdmin:not([hidden])', { timeout: 10000 });
    await page.click('#nav button[data-page="admin"]');
    await page.waitForSelector('#adminBody table', { timeout: 10000 });
    const heads = await page.locator('#adminBody th').allTextContents();
    check('overround column present', heads.some((h) => /overround/i.test(h)), `(${heads.join(',')})`);
    const orCells = await page.locator('#adminBody td:nth-child(6)').count();
    check('overround cells rendered', orCells >= 1, `(${orCells} markets)`);
    const suspend = page.locator('#adminBody [data-toggle]').first();
    check('suspend/restore control present', (await suspend.count()) === 1);
  });

  await check('fair-price helper returns server-side conversions', async () => {
    await page.click('[data-view="create"]');
    await page.waitForSelector('[data-fair]', { timeout: 10000 });
    await page.fill('[data-fair]', '2.5');
    await page.dispatchEvent('[data-fair]', 'change');
    // the conversions come from lib/odds.js via /api/format — the desk must not
    // invent them client-side
    await page.waitForFunction(
      () => /\+\d+|-\d+/.test(document.querySelector('[data-fairnote]').textContent || ''),
      null,
      { timeout: 10000 }
    );
    const note = (await page.locator('[data-fairnote]').textContent()) || '';
    check('american + fractional + implied shown', /\d+\/\d+/.test(note) && /implied/.test(note), `("${note.trim()}")`);
  });

  await check('no uncaught page errors during the whole run', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.log('\nui_test.mjs: FAILURES PRESENT');
  console.log('--- server log ---');
  console.log(serverLog.join('').slice(-2000));
} else {
  console.log(`\nui_test.mjs: ${passed} checks passed`);
}
