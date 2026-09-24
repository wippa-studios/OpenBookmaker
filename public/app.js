// app.js — OpenBookmaker exchange UI.
//
// House convention: ONE IIFE, ONE controlled global (window.OB) shared with
// admin.js — no top-level bindings leak into the page scope (classic scripts
// share a single global scope, so a collision is a fatal SyntaxError).
(() => {
  'use strict';

  // ── state ────────────────────────────────────────────────────────────────
  const state = {
    user: null,
    page: 'markets',
    sport: null,          // active sport slug (null = all)
    sports: [],
    events: [],
    slip: [],             // [{selection_id, selection_name, market_id, market_name, event_name, side, price, stake_cents}]
    betsTab: 'open',
    sse: null,
    pollTimer: null,
    flashTimer: null,
  };

  // ── tiny DOM helpers ─────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Escape ALL server-provided text before it goes near innerHTML. Sport,
  // event and selection names are admin-authored, so they are untrusted.
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Writing innerHTML into a node that a re-render already detached throws
  // NotFoundError ("node to be removed is no longer a child"). Every async
  // writer re-checks with isConnected before touching the DOM.
  function setHtml(node, html) {
    if (!node || !node.isConnected) return false;
    node.innerHTML = html;
    return true;
  }
  const el = (id) => {
    const n = $(id);
    return n && n.isConnected ? n : null;
  };

  const fmt = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
  const signed = (cents) => (cents >= 0 ? '+' : '−') + fmt(Math.abs(cents));
  const price2 = (p) => (p == null ? '—' : Number(p).toFixed(2));

  // ── api ──────────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.status === 401 && state.user) {
      state.user = null;
      renderHeader();
    }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // ── toast ────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.className = '';
    }, 2600);
  }

  // ── client-side tick ladder (mirror of lib/odds.js — UX sugar only;
  //    the server re-snaps every price it accepts, so drift is harmless) ───
  const LADDER = [
    { lo: 1.01, hi: 2.0, step: 0.01 },
    { lo: 2.02, hi: 3.0, step: 0.02 },
    { lo: 3.05, hi: 4.0, step: 0.05 },
    { lo: 4.1, hi: 6.0, step: 0.1 },
    { lo: 6.2, hi: 10.0, step: 0.2 },
    { lo: 10.5, hi: 20.0, step: 0.5 },
    { lo: 21.0, hi: 30.0, step: 1 },
    { lo: 32.0, hi: 50.0, step: 2 },
    { lo: 55.0, hi: 100.0, step: 5 },
    { lo: 110.0, hi: 1000.0, step: 10 },
  ];
  function snap(p) {
    if (!Number.isFinite(p)) return 1.01;
    if (p < 1.01) return 1.01;
    if (p > 1000) return 1000;
    for (const b of LADDER) {
      if (p >= b.lo && p <= b.hi) {
        const idx = Math.round((p - b.lo) / b.step);
        return Math.min(b.hi, Math.max(b.lo, b.lo + idx * b.step));
      }
    }
    let below = 1.01;
    let above = 1000;
    for (const b of LADDER) {
      if (b.hi < p) below = b.hi;
      if (b.lo > p) {
        above = b.lo;
        break;
      }
    }
    return p - below <= above - p ? below : above;
  }
  function stepTick(p, dir) {
    const s = snap(p);
    for (let i = 0; i < LADDER.length; i++) {
      const b = LADDER[i];
      if (s < b.lo || s > b.hi) continue;
      const idx = Math.round((s - b.lo) / b.step);
      const last = Math.round((b.hi - b.lo) / b.step);
      if (dir > 0) return idx < last ? s + b.step : LADDER[i + 1] ? LADDER[i + 1].lo : 1000;
      return idx > 0 ? s - b.step : LADDER[i - 1] ? LADDER[i - 1].hi : 1.01;
    }
    return dir > 0 ? 1000 : 1.01;
  }

  // ── header / auth ────────────────────────────────────────────────────────
  function renderHeader() {
    const bal = $('balance');
    const who = $('who');
    const btn = $('authBtn');
    const admin = $('navAdmin');
    if (state.user) {
      const avail = state.user.balance_cents - state.user.frozen_cents;
      bal.hidden = false;
      bal.innerHTML =
        `<span class="tn">${fmt(avail)}</span> <small>avail · ${fmt(state.user.frozen_cents)} frozen</small>`;
      who.textContent = state.user.username + (state.user.is_admin ? ' · admin' : '');
      btn.textContent = 'Sign out';
      admin.hidden = !state.user.is_admin;
    } else {
      bal.hidden = true;
      who.textContent = '';
      btn.textContent = 'Sign in';
      admin.hidden = true;
    }
  }

  async function refreshMe() {
    try {
      state.user = (await api('GET', '/api/me')).user;
    } catch {
      state.user = null;
    }
    renderHeader();
  }

  async function logout() {
    try {
      await api('POST', '/api/auth/logout');
    } catch (e) {
      toast(e.message, 'err');
    }
    state.user = null;
    state.slip = [];
    renderSlip();
    renderHeader();
    connectSSE(); // the stream carries userId — rebind it to the new identity
    route();
    toast('Signed out');
  }

  let authMode = 'login';
  function openAuth(mode) {
    authMode = mode || 'login';
    $('authTitle').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
    $('authGo').textContent = authMode === 'login' ? 'Sign in' : 'Register';
    $('authSwitch').textContent = authMode === 'login' ? 'Register' : 'Sign in';
    $('authUser').value = '';
    $('authPass').value = '';
    $('authModal').classList.add('show');
    $('authUser').focus();
  }
  const closeAuth = () => $('authModal').classList.remove('show');

  async function submitAuth() {
    const username = $('authUser').value.trim();
    const password = $('authPass').value;
    try {
      const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const r = await api('POST', path, { username, password });
      state.user = r.user;
      closeAuth();
      renderHeader();
      connectSSE(); // private balance/orders events follow the new session
      route();
      toast(authMode === 'login' ? `Welcome back, ${r.user.username}` : 'Account created — top up in Wallet');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ── routing ──────────────────────────────────────────────────────────────
  function route() {
    const hash = (location.hash || '#/markets').replace('#/', '');
    const known = ['markets', 'bets', 'wallet', 'admin'];
    state.page = known.indexOf(hash) >= 0 ? hash : 'markets';
    if (state.page === 'admin' && !(state.user && state.user.is_admin)) state.page = 'markets';
    qa('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === state.page));
    renderPage();
  }

  function renderPage() {
    const page = $('page');
    page.innerHTML = '';
    if (state.page === 'markets') return renderMarkets();
    if (state.page === 'bets') return renderBets();
    if (state.page === 'wallet') return renderWallet();
    if (state.page === 'admin' && window.OBAdmin) return window.OBAdmin.render(page);
    page.innerHTML = '<div class="card"><div class="empty">Nothing here</div></div>';
  }

  // ── data loaders ─────────────────────────────────────────────────────────
  async function loadSports() {
    try {
      state.sports = (await api('GET', '/api/sports')).sports;
    } catch {
      state.sports = [];
    }
    renderSportNav();
  }

  async function loadEvents() {
    try {
      const qs = state.sport ? `?sport=${encodeURIComponent(state.sport)}` : '';
      state.events = (await api('GET', '/api/events' + qs)).events;
    } catch {
      state.events = [];
    }
    if (state.page === 'markets') renderMarkets();
  }

  async function refreshAll() {
    await Promise.all([refreshMe(), loadSports(), loadEvents()]);
  }

  // ── sports filter ────────────────────────────────────────────────────────
  function renderSportNav() {
    let bar = $('sportbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sportbar';
      bar.className = 'sportbar';
      $('nav').parentNode.insertBefore(bar, $('nav').nextSibling);
    }
    const all = `<button class="chip ${state.sport === null ? 'on' : ''}" data-sport="">All</button>`;
    const chips = state.sports
      .map(
        (s) =>
          `<button class="chip ${state.sport === s.slug ? 'on' : ''}" data-sport="${esc(s.slug)}">${esc(s.name)} <span class="muted">${s.event_count}</span></button>`
      )
      .join('');
    bar.innerHTML = all + chips;
    qa('button[data-sport]', bar).forEach((b) => {
      b.onclick = () => {
        state.sport = b.dataset.sport || null;
        renderSportNav();
        loadEvents();
      };
    });
  }

  // ── markets page (Betfair-style ladder) ──────────────────────────────────
  function whenText(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderMarkets() {
    const page = el('page');
    if (!page) return;
    if (!state.events.length) {
      page.innerHTML = '<div class="card"><div class="empty">No open events right now</div></div>';
      return;
    }
    const groups = new Map();
    for (const e of state.events) {
      const key = e.competition || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    let html = '';
    for (const [comp, evs] of groups) {
      html += `<div class="card"><h3>${esc(comp)}</h3>`;
      for (const e of evs) {
        html += `<div class="event">
          <div class="evmeta">
            <span class="nm">${esc(e.name)}</span>
            <span class="when">${whenText(e.starts_at)}</span>
            <span class="chip ${esc(e.status)}">${esc(e.status)}</span>
          </div>`;
        for (const m of e.markets) {
          html += `<div class="mkt">
            <div class="mkthead">
              <span>${esc(m.name)}</span>
              <span class="chip ${esc(m.status)}">${esc(m.status)}</span>
              <span class="muted tn">${fmt(m.total_matched_cents)} matched</span>
            </div>
            ${ladderHtml(m, e)}
          </div>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    page.innerHTML = html;
    bindLadder();
  }

  // Betfair look: the best back price sits nearest the runner (rightmost of
  // the three left cells); the best lay price nearest the runner (leftmost of
  // the right cells).
  function ladderHtml(market, event) {
    let rows = '<div class="lrow lhdr"><div class="hdr b">BACK</div><div class="hdr mid">SELECTION</div><div class="hdr l">LAY</div></div>';
    for (const sel of market.selections) {
      if (sel.status !== 'open') {
        rows += `<div class="lrow"><div class="lstack"></div><div class="lmid"><div class="nm">${esc(
          sel.name
        )}</div><div class="ltp muted">${esc(sel.status)}</div></div><div class="lstack"></div></div>`;
        continue;
      }
      const back = (sel.back || []).slice(0, 3);
      const lay = (sel.lay || []).slice(0, 3);
      const backCells = [back[2], back[1], back[0]].map((lv) => cellHtml(sel, market, event, lv, 'back'));
      const layCells = [lay[0], lay[1], lay[2]].map((lv) => cellHtml(sel, market, event, lv, 'lay'));
      // Grid auto-placement is ROW-major, so the three prices of one side must
      // be wrapped in a stack: [back stack | runner | lay stack]. Without the
      // wrapper they spread across the columns and the ladder loses its shape.
      rows +=
        `<div class="lrow"><div class="lstack">${backCells.join('')}</div>` +
        `<div class="lmid"><div class="nm">${esc(sel.name)}</div><div class="ltp tn">${price2(sel.ltp)}</div></div>` +
        `<div class="lstack">${layCells.join('')}</div></div>`;
    }
    return `<div class="ladder">${rows}</div>`;
  }

  function cellHtml(sel, market, event, lv, side) {
    if (!lv || !lv.size_cents) return '<div class="lcell empty">–</div>';
    const key = `${sel.selection_id}:${side}:${lv.price}`;
    const prev = lastPrices.get(key);
    lastPrices.set(key, lv.price);
    const flash = prev === undefined || prev === lv.price ? '' : lv.price > prev ? ' flash-up' : ' flash-down';
    return (
      `<div class="lcell ${side}${flash}" data-bet="1" data-sel="${sel.selection_id}" ` +
      `data-sname="${esc(sel.name)}" data-mkt="${market.id}" data-mname="${esc(market.name)}" ` +
      `data-evt="${esc(event.name)}" data-side="${side}" data-price="${lv.price}">` +
      `<span class="p tn">${price2(lv.price)}</span><span class="s tn">${fmt(lv.size_cents)}</span></div>`
    );
  }

  // Last rendered price per (selection, side, price) for the flash effect.
  const lastPrices = new Map();

  function bindLadder() {
    qa('#page [data-bet]').forEach((c) => {
      c.onclick = () => {
        if (!state.user) {
          toast('Sign in to place a bet', 'err');
          openAuth('login');
          return;
        }
        addToSlip({
          selection_id: Number(c.dataset.sel),
          selection_name: c.dataset.sname,
          market_id: Number(c.dataset.mkt),
          market_name: c.dataset.mname,
          event_name: c.dataset.evt,
          side: c.dataset.side,
          price: Number(c.dataset.price),
        });
      };
    });
    // Price flashes decay on their own so a fresh board keeps the tint brief.
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => {
      qa('#page .flash-up, #page .flash-down').forEach((c) => c.classList.remove('flash-up', 'flash-down'));
    }, 700);
  }

  // ── bet slip ─────────────────────────────────────────────────────────────
  function addToSlip(item) {
    const at = state.slip.findIndex((x) => x.selection_id === item.selection_id && x.side === item.side);
    if (at >= 0) {
      state.slip.splice(at, 1);
    } else {
      if (state.slip.length >= 10) {
        toast('Slip is full (10 selections max)', 'err');
        return;
      }
      state.slip.push(Object.assign({ stake_cents: 1000 }, item));
    }
    renderSlip();
  }

  // One slip row's derived values (preview + button label) — recomputed in
  // place. Rebuilding the whole slip from inside an input's change handler
  // detaches the node the browser is dispatching on, which Chromium reports
  // as "NotFoundError: the node to be removed is no longer a child"; updating
  // only the affected row also preserves focus while typing.
  function slipRowHtml(it) {
    const exposure = Math.round((it.price - 1) * it.stake_cents);
    const detail =
      it.side === 'back'
        ? `<span class="muted">Profit</span> ${fmt(exposure)} · <span class="muted">Return</span> ${fmt(it.stake_cents + exposure)}`
        : `<span class="muted">Liability</span> ${fmt(exposure)} · <span class="muted">Return</span> ${fmt(it.stake_cents + exposure)}`;
    return `<div class="sliphead">
            <div>
              <span class="side ${esc(it.side)}">${esc(it.side.toUpperCase())}</span>
              <strong>${esc(it.selection_name)}</strong>
              <span class="tn">@ ${price2(it.price)}</span>
              <div class="muted ellipsis">${esc(it.event_name)} · ${esc(it.market_name)}</div>
            </div>
            <button class="rm" data-rm="ROW" title="Remove">×</button>
          </div>
          <div class="slipgrid">
            <div>
              <label>Stake</label>
              <input class="stake" data-stake="ROW" type="number" min="1" step="0.01" value="${(it.stake_cents / 100).toFixed(2)}" />
            </div>
            <div>
              <label>Price</label>
              <div class="stepper">
                <button class="btn sm" data-tick="ROW" data-dir="-1">−</button>
                <input class="tn" data-price="ROW" value="${price2(it.price)}" />
                <button class="btn sm" data-tick="ROW" data-dir="1">+</button>
              </div>
            </div>
          </div>
          <div class="prev tn">${detail}</div>
          <button class="btn primary place" data-place="ROW">Place ${fmt(it.stake_cents)}</button>`;
  }

  // Update ONE row's derived values in place — never restructure the row.
  // Rebuilding a row detaches the focused input, which fires blur -> change
  // and re-enters this function while the DOM is being mutated (Chromium then
  // reports "removeChild: the node to be removed is no longer a child").
  // Writing only text/values also keeps focus while the user types.
  function slipDetailText(it) {
    const exposure = Math.round((it.price - 1) * it.stake_cents);
    const label = it.side === 'back' ? 'Profit' : 'Liability';
    return `${label} ${fmt(exposure)} · Return ${fmt(it.stake_cents + exposure)}`;
  }

  function updateSlipRow(i) {
    const row = document.querySelector(`.sliprow[data-row="${i}"]`);
    const it = state.slip[i];
    if (!row || !it) return;
    const priceInput = row.querySelector('[data-price]');
    // Never fight the user for the field they are typing in.
    if (priceInput && document.activeElement !== priceInput) priceInput.value = price2(it.price);
    const headPrice = row.querySelector('.sliphead .tn');
    if (headPrice) headPrice.textContent = `@ ${price2(it.price)}`;
    const prev = row.querySelector('.prev');
    if (prev) prev.textContent = slipDetailText(it);
    const place = row.querySelector('[data-place]');
    if (place) place.textContent = `Place ${fmt(it.stake_cents)}`;
    const stakeInput = row.querySelector('[data-stake]');
    if (stakeInput && document.activeElement !== stakeInput) stakeInput.value = (it.stake_cents / 100).toFixed(2);
  }

  function bindSlipRow(row, i) {
    const rm = row.querySelector('[data-rm]');
    if (rm) {
      rm.onclick = () => {
        state.slip.splice(i, 1);
        renderSlip();
      };
    }
    const stake = row.querySelector('[data-stake]');
    if (stake) {
      stake.onchange = () => {
        const cents = Math.round(parseFloat(stake.value) * 100);
        state.slip[i].stake_cents = Number.isFinite(cents) && cents > 0 ? cents : 1000;
        updateSlipRow(i);
      };
    }
    row.querySelectorAll('[data-tick]').forEach((b) => {
      b.onclick = () => {
        state.slip[i].price = stepTick(state.slip[i].price, Number(b.dataset.dir));
        updateSlipRow(i);
      };
    });
    const price = row.querySelector('[data-price]');
    if (price) {
      // Typed prices are honoured (snapped to the ladder), never ignored.
      price.onchange = () => {
        const parsed = parseFloat(price.value);
        if (!Number.isFinite(parsed)) {
          toast('Enter a valid price', 'err');
          updateSlipRow(i);
          return;
        }
        state.slip[i].price = snap(parsed);
        updateSlipRow(i);
      };
    }
    const place = row.querySelector('[data-place]');
    if (place) place.onclick = () => placeOne(i, place);
  }

  function renderSlip() {
    const wrap = el('slip');
    const body = el('slipBody');
    if (!wrap || !body) return;
    if (!state.slip.length) {
      wrap.hidden = true;
      body.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    body.innerHTML = state.slip
      .map((it, i) => `<div class="sliprow" data-row="${i}">${slipRowHtml(it).replace(/ROW/g, String(i))}</div>`)
      .join('');
    qa('.sliprow', body).forEach((row, i) => bindSlipRow(row, i));
  }

  async function placeOne(i, btn) {
    const it = state.slip[i];
    if (!it) return;
    btn.disabled = true;
    btn.textContent = 'Placing…';
    try {
      const r = await api('POST', '/api/orders', {
        selection_id: it.selection_id,
        side: it.side,
        price: it.price,
        stake_cents: it.stake_cents,
      });
      const matched = r.fills.reduce((a, f) => a + f.stake_cents, 0);
      const resting = r.order.stake_cents - r.order.matched_cents;
      if (matched > 0 && resting === 0) toast(`Matched ${fmt(matched)} @ ${price2(r.fills[0].price)}`);
      else if (matched > 0) toast(`Matched ${fmt(matched)} · ${fmt(resting)} resting @ ${price2(r.order.price)}`);
      else toast(`Resting ${fmt(r.order.stake_cents)} @ ${price2(r.order.price)}`);
      state.slip.splice(i, 1);
      renderSlip();
      refreshMe();
      loadEvents();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // ── my bets ──────────────────────────────────────────────────────────────
  function renderBets() {
    const page = el('page');
    if (!page) return;
    if (!state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to see your orders, positions and history.</div>' +
        '<div class="row" style="justify-content:center"><button class="btn primary" id="betsSignin">Sign in</button></div></div>';
      $('betsSignin').onclick = () => openAuth('login');
      return;
    }
    page.innerHTML = `<div class="card">
      <div class="tabs">
        <button class="btn sm ${state.betsTab === 'open' ? 'primary' : ''}" data-tab="open">Open orders</button>
        <button class="btn sm ${state.betsTab === 'positions' ? 'primary' : ''}" data-tab="positions">Positions</button>
        <button class="btn sm ${state.betsTab === 'settled' ? 'primary' : ''}" data-tab="settled">Settled</button>
      </div>
      <div id="betsBody"><div class="empty">Loading…</div></div>
    </div>`;
    qa('[data-tab]', page).forEach((b) => {
      b.onclick = () => {
        state.betsTab = b.dataset.tab;
        renderBets();
      };
    });
    if (state.betsTab === 'open') loadOpenOrders();
    else if (state.betsTab === 'positions') loadPositions();
    else loadSettled();
  }

  async function loadOpenOrders() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { orders } = await api('GET', '/api/orders');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!orders.length) {
        setHtml(body, '<div class="empty">No unmatched orders</div>');
        return;
      }
      setHtml(body,
        '<table><thead><tr><th>Event</th><th>Selection</th><th>Side</th><th>Price</th><th>Unmatched</th><th>Placed</th><th></th></tr></thead><tbody>' +
        orders
          .map(
            (o) => `<tr>
          <td>${esc(o.event_name)}<div class="muted">${esc(o.market_name)}</div></td>
          <td>${esc(o.selection_name)}</td>
          <td class="side ${esc(o.side)}">${esc(o.side.toUpperCase())}</td>
          <td class="tn">${price2(o.price)}</td>
          <td class="tn">${fmt(o.stake_cents - o.matched_cents)}</td>
          <td class="muted">${whenText(o.placed_at)}</td>
          <td><button class="btn sm red" data-cancel="${o.id}">Cancel</button></td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
      qa('[data-cancel]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api('POST', `/api/orders/${b.dataset.cancel}/cancel`);
            toast('Order cancelled');
            loadOpenOrders();
            refreshMe();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  async function loadPositions() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { positions } = await api('GET', '/api/positions');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!positions.length) {
        setHtml(body, '<div class="empty">No matched positions</div>');
        return;
      }
      setHtml(body, positions
        .map((p) => {
          const legs = p.selections
            .filter((s) => s.my_back_stake_cents || s.my_lay_stake_cents || s.frozen_cents)
            .map(
              (s) => `<tr>
                <td>${esc(s.name)}</td>
                <td class="tn">${s.my_back_stake_cents ? fmt(s.my_back_stake_cents) : '—'}</td>
                <td class="tn">${s.my_lay_stake_cents ? fmt(s.my_lay_stake_cents) : '—'}</td>
                <td class="tn">${fmt(s.frozen_cents)}</td>
              </tr>`
            )
            .join('');
          const matrix = p.pnl_if_win
            .map(
              (w) =>
                `<span class="pnlchip ${w.pnl_cents >= 0 ? 'win' : 'loss'}">${esc(w.name)} ${signed(w.pnl_cents)}</span>`
            )
            .join('');
          const cash =
            p.cashout != null
              ? `<button class="btn green" data-cashout="${p.market_id}">Cash out ${signed(p.cashout.value_cents)} @ ${price2(
                  p.cashout.hedge_price
                )}</button>`
              : '<span class="muted">Cash out unavailable</span>';
          return `<div class="poscard">
            <div class="poshead">
              <div><strong>${esc(p.market_name)}</strong> <span class="chip ${esc(p.market_status)}">${esc(
            p.market_status
          )}</span></div>
              <div class="muted">${esc(p.event_name)}</div>
            </div>
            <table><thead><tr><th>Selection</th><th>Backed</th><th>Laid</th><th>Frozen</th></tr></thead><tbody>${legs}</tbody></table>
            <div class="pnlrow">${matrix}</div>
            <div>${cash}</div>
          </div>`;
        })
        .join(''));
      qa('[data-cashout]', body).forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await api('POST', `/api/markets/${b.dataset.cashout}/cashout`);
            toast(`Cashed out ${signed(r.value_cents)}`);
            loadPositions();
            refreshMe();
            loadEvents();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  async function loadSettled() {
    if (!el('betsBody')) return; // navigated away mid-flight
    try {
      const { settlements } = await api('GET', '/api/settlements');
      const body = el('betsBody');
      if (!body) return; // tab changed while the request was in flight
      if (!settlements.length) {
        setHtml(body, '<div class="empty">No settled markets yet</div>');
        return;
      }
      setHtml(body,
        '<table><thead><tr><th>Event</th><th>Market</th><th>Result</th><th>P&amp;L</th><th>Commission</th><th>When</th></tr></thead><tbody>' +
        settlements
          .map(
            (s) => `<tr>
          <td>${esc(s.event_name)}</td>
          <td>${esc(s.market_name)}</td>
          <td>${esc(s.selection_name || 'Void')}</td>
          <td class="tn ${s.pnl_cents >= 0 ? 'win' : 'loss'}">${signed(s.pnl_cents)}</td>
          <td class="tn muted">${fmt(s.commission_cents)}</td>
          <td class="muted">${whenText(s.at)}</td>
        </tr>`
          )
          .join('') +
        '</tbody></table>');
    } catch (e) {
      setHtml(el('betsBody'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  // ── wallet ───────────────────────────────────────────────────────────────
  function renderWallet() {
    const page = el('page');
    if (!page) return;
    if (!state.user) {
      page.innerHTML =
        '<div class="card"><div class="empty">Sign in to use the wallet.</div>' +
        '<div class="row" style="justify-content:center"><button class="btn primary" id="walSignin">Sign in</button></div></div>';
      $('walSignin').onclick = () => openAuth('login');
      return;
    }
    page.innerHTML = `<div class="card">
      <h3>Wallet</h3>
      <div class="wgrid">
        <div><span class="muted">Balance</span><div class="wbig tn" id="wBal">—</div></div>
        <div><span class="muted">Available</span><div class="wbig tn" id="wAvail">—</div></div>
        <div><span class="muted">Frozen (escrow)</span><div class="wbig tn" id="wFroz">—</div></div>
      </div>
      <div class="row" style="margin:12px 0">
        <span class="muted">Faucet:</span>
        <button class="btn sm" data-dep="1000">$10</button>
        <button class="btn sm" data-dep="5000">$50</button>
        <button class="btn sm" data-dep="10000">$100</button>
        <button class="btn sm" data-dep="100000">$1,000</button>
      </div>
      <h3>Transactions</h3>
      <div id="wTx"><div class="empty">Loading…</div></div>
    </div>`;
    qa('[data-dep]', page).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api('POST', '/api/wallet/deposit', { amount_cents: Number(b.dataset.dep) });
          toast(`Added ${fmt(Number(b.dataset.dep))} play money`);
          loadWallet();
          refreshMe();
        } catch (e) {
          toast(e.message, 'err');
        }
        b.disabled = false;
      };
    });
    loadWallet();
  }

  async function loadWallet() {
    if (!el('wTx')) return; // navigated away mid-flight
    try {
      const w = await api('GET', '/api/wallet');
      const balEl = el('wBal');
      if (!balEl || !el('wTx')) return; // left the wallet page mid-flight
      balEl.textContent = fmt(w.balance_cents);
      el('wAvail').textContent = fmt(w.available_cents);
      el('wFroz').textContent = fmt(w.frozen_cents);
      const tx = el('wTx');
      if (!w.transactions.length) {
        setHtml(tx, '<div class="empty">No transactions yet</div>');
        return;
      }
      const credits = ['deposit', 'settle', 'refund', 'release'];
      setHtml(tx,
        '<table><thead><tr><th>Type</th><th>Amount</th><th>Balance</th><th>Frozen</th><th>When</th></tr></thead><tbody>' +
        w.transactions
          .map((t) => {
            const isCredit = credits.indexOf(t.type) >= 0 && t.amount_cents >= 0;
            const cls = t.type === 'commission' || t.amount_cents < 0 ? 'loss' : isCredit ? 'win' : 'muted';
            const amt = t.type === 'escrow' || t.type === 'release' ? fmt(Math.abs(t.amount_cents)) : signed(t.amount_cents);
            return `<tr>
              <td>${esc(t.type)}</td>
              <td class="tn ${cls}">${amt}</td>
              <td class="tn">${fmt(t.balance_after)}</td>
              <td class="tn">${fmt(t.frozen_after)}</td>
              <td class="muted">${whenText(t.at)}</td>
            </tr>`;
          })
          .join('') +
        '</tbody></table>');
    } catch (e) {
      setHtml(el('wTx'), `<div class="empty">${esc(e.message)}</div>`);
    }
  }

  // ── SSE ──────────────────────────────────────────────────────────────────
  function connectSSE() {
    if (state.sse) state.sse.close();
    const es = new EventSource('/api/stream');
    es.addEventListener('book', () => {
      if (state.page === 'markets') loadEvents();
    });
    es.addEventListener('balance', () => {
      refreshMe();
      if (state.page === 'wallet') loadWallet();
    });
    es.addEventListener('orders', () => {
      if (state.page === 'bets') renderBets();
    });
    es.addEventListener('settlement', () => {
      if (state.page === 'markets') loadEvents();
      if (state.page === 'bets') renderBets();
    });
    // EventSource reconnects on its own; a 401 close means the session died.
    es.addEventListener('error', () => {});
    state.sse = es;
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    qa('#nav button').forEach((b) => {
      b.onclick = () => {
        location.hash = '#/' + b.dataset.page;
      };
    });
    $('authBtn').onclick = () => (state.user ? logout() : openAuth('login'));
    $('authGo').onclick = submitAuth;
    $('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
    $('authPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAuth();
    });
    $('authUser').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAuth();
    });
    $('authModal').onclick = (e) => {
      if (e.target.id === 'authModal') closeAuth();
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAuth();
    });
    window.addEventListener('hashchange', route);

    await refreshMe();
    await loadSports();
    await loadEvents();
    renderSlip();
    connectSSE();
    // Poll fallback so the board still moves if the stream drops.
    state.pollTimer = setInterval(() => {
      if (state.page === 'markets') loadEvents();
    }, 15000);
    route();
  }

  // Controlled global consumed by admin.js (the one allowed browser global).
  window.OB = { api, toast, fmt, price2, esc, whenText, state, refreshMe, refreshAll, loadEvents, route, renderPage };

  let booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOnce);
  } else {
    bootOnce();
  }
})();
