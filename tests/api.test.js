// api.test.js — HTTP integration, fully offline:
//   :memory: DB (via env BEFORE requires), ephemeral port-0 server,
//   BOT_ENABLED=false, DRIFT_ENABLED=false.
// Flow: register → deposit → board → place orders → match → positions →
//       admin settle → wallet reflects credit net of commission.
'use strict';
process.env.DB_PATH = ':memory:';
process.env.DRIFT_ENABLED = 'false';
process.env.BOT_ENABLED = 'false';

const assert = require('assert');
const srv = require('../server');

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ok', name);
};

(async () => {
  const server = srv.app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const j = async (method, path, { body, cookie, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json, setCookie };
  };
  const cookieOf = (r) => (r.setCookie.find((c) => c.startsWith('ob_session=')) || '').split(';')[0];

  try {
    // ── register + auto-login ──────────────────────────────────────────
    await check('register → 201 + session cookie + user', async () => {
      const r = await j('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } });
      assert.strictEqual(r.status, 201);
      assert.ok(r.json.user && r.json.user.username === 'alice');
      assert.strictEqual(r.json.user.pass_hash, undefined);
      assert.ok(cookieOf(r).startsWith('ob_session='));
    });

    const aliceLogin = await j('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
    const alice = cookieOf(aliceLogin);
    const bobLogin = await j('POST', '/api/auth/register', { body: { username: 'bob', password: 'secret2' } });
    const bob = cookieOf(bobLogin);
    await j('POST', '/api/wallet/deposit', { body: { amount_cents: 50000 }, cookie: bob }); // faucet before trading

    await check('401 without session', async () => {
      const r = await j('GET', '/api/me');
      assert.strictEqual(r.status, 401);
    });

    // ── faucet deposit ─────────────────────────────────────────────────
    await check('deposit + faucet cap', async () => {
      const r = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 50000 }, cookie: alice });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.balance_cents, 50000);
      const over = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100001 }, cookie: alice });
      assert.strictEqual(over.status, 400);
      const bad = await j('POST', '/api/wallet/deposit', { body: { amount_cents: -5 }, cookie: alice });
      assert.strictEqual(bad.status, 400);
    });

    // ── board ──────────────────────────────────────────────────────────
    let marketId = null;
    let selId = null;
    await check('sports + events board (seeded)', async () => {
      const sp = await j('GET', '/api/sports');
      assert.strictEqual(sp.status, 200);
      assert.ok(sp.json.sports.some((s) => s.slug === 'football'));
      const ev = await j('GET', '/api/events?sport=football');
      assert.strictEqual(ev.status, 200);
      assert.ok(ev.json.events.length >= 4);
      const m = ev.json.events[0].markets[0];
      assert.ok(m && m.selections.length >= 2);
      marketId = m.id;
      selId = m.selections[0].selection_id;
      // prices are valid ladder ticks with 2dp
      for (const sel of m.selections) {
        assert.ok(sel.back.every((l) => l.price >= 1.01 && l.price <= 1000));
      }
    });

    // ── trading: alice back (rests) → bob lay (matches) ─────────────────
    await check('place order → rests without liquidity', async () => {
      const r = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 10000 }, cookie: alice });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.json.order.status, 'open');
      assert.strictEqual(r.json.order.matched_cents, 0);
    });

    await check('bob lay matches alice back at resting price', async () => {
      const r = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'lay', price: 2.5, stake_cents: 10000 }, cookie: bob });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.json.order.status, 'fully_matched');
      assert.deepStrictEqual(r.json.fills, [{ price: 2.5, stake_cents: 10000 }]);
      // bob's liability escrow (2.5-1)*10000 = 15000
      const me = await j('GET', '/api/me', { cookie: bob });
      assert.strictEqual(me.json.user.frozen_cents, 15000);
    });

    await check('positions matrix + escrow', async () => {
      const r = await j('GET', '/api/positions', { cookie: alice });
      assert.strictEqual(r.status, 200);
      const pos = r.json.positions.find((p) => p.market_id === marketId);
      assert.ok(pos);
      const leg = pos.selections.find((s) => s.selection_id === selId);
      assert.strictEqual(leg.my_back_stake_cents, 10000);
      assert.strictEqual(leg.frozen_cents, 10000);
      // if-win P&L: +15000 profit; if-lose: -10000
      const pnlWin = pos.pnl_if_win.find((x) => x.selection_id === selId);
      assert.strictEqual(pnlWin.pnl_cents, 15000);
    });

    await check('open orders list + validation errors', async () => {
      const bad = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: '10000' }, cookie: alice });
      assert.strictEqual(bad.status, 400);
      const low = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 50 }, cookie: alice });
      assert.strictEqual(low.status, 400);
    });

    // ── admin: settle → wallet reflects credit net of commission ────────
    await check('admin settle → settlement credit net of commission', async () => {
      const adminLogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      assert.strictEqual(adminLogin.status, 200);
      const admin = cookieOf(adminLogin);
      const r = await j('POST', `/api/admin/markets/${marketId}/settle`, { body: { winner_selection_id: selId }, cookie: admin });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.market.status, 'settled');
      // alice: 50000 + 15000 profit - round(15000*0.025)=375 → 64625
      const w = await j('GET', '/api/wallet', { cookie: alice });
      assert.strictEqual(w.json.balance_cents, 64625);
      assert.strictEqual(w.json.frozen_cents, 0);
      // bob: lost his liability (2.5-1)*10000 = 15000 → 50000 - 15000 = 35000
      const wb = await j('GET', '/api/wallet', { cookie: bob });
      assert.strictEqual(wb.json.balance_cents, 35000);
      // settled market rejects orders
      const po = await j('POST', '/api/orders', { body: { selection_id: selId, side: 'back', price: 2.5, stake_cents: 10000 }, cookie: alice });
      assert.strictEqual(po.status, 409);
    });

    // ── admin stats + role guards ───────────────────────────────────────
    await check('admin stats + role guard', async () => {
      const adminLogin = await j('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      const admin = cookieOf(adminLogin);
      const r = await j('GET', '/api/admin/stats', { cookie: admin });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.markets.length >= 1);
      const forbidden = await j('GET', '/api/admin/stats', { cookie: alice });
      assert.strictEqual(forbidden.status, 403);
    });

    // ── origin guard ────────────────────────────────────────────────────
    await check('origin guard: foreign origin 403', async () => {
      const r = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100 }, cookie: alice, origin: 'https://evil.example' });
      assert.strictEqual(r.status, 403);
      const ok = await j('POST', '/api/wallet/deposit', { body: { amount_cents: 100 }, cookie: alice, origin: `http://127.0.0.1:${port}` });
      assert.strictEqual(ok.status, 200);
    });

    // ── SSE stream ──────────────────────────────────────────────────────
    await check('SSE stream responds with event-stream', async () => {
      const res = await fetch(`${base}/api/stream`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').startsWith('text/event-stream'));
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.ok(new TextDecoder().decode(value).includes('retry:'));
      await reader.cancel();
    });

    console.log(`\napi.test.js: ${passed} checks passed`);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
