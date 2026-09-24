// admin.js — admin trading desk (IIFE; consumes the single window.OB global
// exported by app.js). Every call below maps to a real API route.
(() => {
  'use strict';

  const OB = window.OB;
  if (!OB) {
    console.error('[admin] window.OB missing — app.js must load first');
    return;
  }
  const { api, toast, fmt, price2, esc, whenText, state, refreshMe, refreshAll } = OB;

  let cache = { sports: [], events: [], stats: { markets: [] } };

  async function render(page) {
    if (!(state.user && state.user.is_admin)) {
      page.innerHTML = '<div class="card"><div class="empty">Admin only</div></div>';
      return;
    }
    page.innerHTML = `
      <div class="card">
        <h3>Trading desk</h3>
        <div class="tabs">
          <button class="btn sm primary" data-view="markets">Markets</button>
          <button class="btn sm" data-view="create">Create</button>
        </div>
        <div id="adminBody"></div>
      </div>`;
    page.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        page.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('primary'));
        b.classList.add('primary');
        if (b.dataset.view === 'markets') renderMarketsView();
        else renderCreateView();
      };
    });
    renderMarketsView();
  }

  // ── markets + settlement ────────────────────────────────────────────────
  async function renderMarketsView() {
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { markets } = await api('GET', '/api/admin/stats');
      cache.stats = { markets };
      if (!markets.length) {
        body.innerHTML = '<div class="empty">No markets</div>';
        return;
      }
      body.innerHTML =
        '<table><thead><tr><th>Market</th><th>Event</th><th>Status</th><th>Matched</th><th>Open orders</th><th>Actions</th></tr></thead><tbody>' +
        markets
          .map(
            (m) => `<tr>
          <td>${esc(m.name)}</td>
          <td>${esc(m.event_name)}</td>
          <td><span class="chip ${esc(m.status)}">${esc(m.status)}</span></td>
          <td class="tn">${fmt(m.total_matched_cents)}</td>
          <td class="tn">${m.open_orders}</td>
          <td>${
            m.status === 'settled'
              ? '<span class="muted">settled</span>'
              : `<button class="btn sm" data-toggle="${m.id}" data-status="${m.status === 'open' ? 'suspended' : 'open'}">${
                  m.status === 'open' ? 'Suspend' : 'Restore'
                }</button>
                 <button class="btn sm primary" data-settle="${m.id}">Settle</button>`
          }</td>
        </tr>`
          )
          .join('') +
        '</tbody></table>';

      body.querySelectorAll('[data-toggle]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api('PATCH', `/api/admin/markets/${b.dataset.toggle}`, { status: b.dataset.status });
            toast('Market ' + b.dataset.status);
            renderMarketsView();
            refreshAll();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
          }
        };
      });
      body.querySelectorAll('[data-settle]').forEach((b) => {
        b.onclick = () => settleDialog(b.dataset.settle);
      });
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  async function settleDialog(marketId) {
    let book;
    let market;
    try {
      const r = await api('GET', `/api/markets/${marketId}/book`);
      book = r.book;
      market = r.market;
    } catch (e) {
      return toast(e.message, 'err');
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="box">
        <h3>Settle ${esc(market.name)}</h3>
        <p class="muted" style="margin-top:0">${whenText(market.settled_at) ? '' : 'Pick the winning runner, or void the market (everyone is refunded).'}</p>
        <div id="sdWinners">
          ${book
            .map(
              (s) => `<label class="optrow"><input type="radio" name="winner" value="${s.selection_id}" /> ${esc(
                s.name
              )} <span class="muted tn">LTP ${price2(s.ltp)}</span></label>`
            )
            .join('')}
        </div>
        <label class="optrow"><input type="checkbox" id="sdVoid" /> Void market (refund all stakes)</label>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="sdGo" style="flex:1">Settle</button>
          <button class="btn" id="sdCancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('#sdCancel').onclick = close;
    overlay.querySelector('#sdVoid').onchange = (e) => {
      overlay.querySelectorAll('input[name="winner"]').forEach((r) => {
        r.disabled = e.target.checked;
      });
    };
    overlay.querySelector('#sdGo').onclick = async () => {
      const isVoid = overlay.querySelector('#sdVoid').checked;
      const winner = overlay.querySelector('input[name="winner"]:checked');
      if (!isVoid && !winner) return toast('Pick a winner or void the market', 'err');
      const go = overlay.querySelector('#sdGo');
      go.disabled = true;
      try {
        const r = await api('POST', `/api/admin/markets/${marketId}/settle`, isVoid ? { void: true } : { winner_selection_id: Number(winner.value) });
        const fees = r.per_user.reduce((a, u) => a + u.commission_cents, 0);
        toast(`Settled ${r.per_user.length} position(s) · commission ${fmt(fees)}`);
        close();
        renderMarketsView();
        refreshAll();
      } catch (e) {
        toast(e.message, 'err');
        go.disabled = false;
      }
    };
  }

  // ── create form ─────────────────────────────────────────────────────────
  async function renderCreateView() {
    const body = document.getElementById('adminBody');
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const sports = (await api('GET', '/api/sports')).sports;
      const events = (await api('GET', '/api/events')).events;
      cache = { sports, events, stats: cache.stats };
      const sportOpts = sports.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      const eventOpts = events.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
      const marketOpts = events
        .filter((e) => e.markets.length)
        .map((e) => `<optgroup label="${esc(e.name)}">${e.markets.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</optgroup>`)
        .join('');
      body.innerHTML = `
        <div class="creategrid">
          <form class="card" data-f="sport">
            <h3>Sport</h3>
            <label>Name</label><input name="name" placeholder="Football" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="comp">
            <h3>Competition</h3>
            <label>Sport</label><select name="sport_id">${sportOpts}</select>
            <label>Name</label><input name="name" placeholder="Premier League" />
            <label>Country</label><input name="country" placeholder="ENG" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="event">
            <h3>Event</h3>
            <label>Sport</label><select name="sport_id">${sportOpts}</select>
            <label>Competition</label><select name="competition_id" data-comps><option value="">—</option></select>
            <label>Name</label><input name="name" placeholder="Arsenal vs Chelsea" />
            <label>Starts (UTC)</label><input name="starts_at" type="datetime-local" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="market">
            <h3>Market</h3>
            <label>Event</label><select name="event_id">${eventOpts}</select>
            <label>Name</label><input name="name" placeholder="Match Odds" />
            <button class="btn primary" type="submit">Create</button>
          </form>
          <form class="card" data-f="sel">
            <h3>Selection</h3>
            <label>Market</label><select name="market_id">${marketOpts}</select>
            <label>Name</label><input name="name" placeholder="Arsenal" />
            <label>Fair price</label><input name="fair_price" type="number" step="0.01" min="1.01" max="1000" placeholder="2.40" />
            <button class="btn primary" type="submit">Create</button>
          </form>
        </div>
        <p class="muted">Creating a selection with a fair price makes the bot quote ladders around it (when bots are enabled).</p>`;

      // competition dropdown follows the chosen sport
      const evtForm = body.querySelector('form[data-f="event"]');
      const compSel = evtForm.querySelector('[name="competition_id"]');
      evtForm.querySelector('[name="sport_id"]').onchange = async (e) => {
        const sid = e.target.value;
        if (!sid) {
          compSel.innerHTML = '<option value="">—</option>';
          return;
        }
        try {
          const { competitions } = await api('GET', `/api/admin/competitions?sport_id=${encodeURIComponent(sid)}`);
          compSel.innerHTML = '<option value="">—</option>' + competitions.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
        } catch {
          compSel.innerHTML = '<option value="">—</option>';
        }
      };

      body.querySelectorAll('form[data-f]').forEach((form) => {
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const btn = form.querySelector('button');
          const get = (n) => {
            const el = form.querySelector(`[name="${n}"]`);
            return el ? el.value.trim() : '';
          };
          const kind = form.dataset.f;
          const payload = {};
          try {
            if (kind === 'sport') payload.name = get('name');
            if (kind === 'comp') {
              payload.sport_id = Number(get('sport_id'));
              payload.name = get('name');
              payload.country = get('country') || null;
            }
            if (kind === 'event') {
              payload.sport_id = Number(get('sport_id'));
              payload.competition_id = get('competition_id') ? Number(get('competition_id')) : null;
              payload.name = get('name');
              payload.starts_at = get('starts_at').replace('T', ' ');
            }
            if (kind === 'market') {
              payload.event_id = Number(get('event_id'));
              payload.name = get('name');
            }
            if (kind === 'sel') {
              payload.market_id = Number(get('market_id'));
              payload.name = get('name');
              const fp = get('fair_price');
              payload.fair_price = fp === '' ? null : Number(fp);
            }
            btn.disabled = true;
            const path = {
              sport: '/api/admin/sports',
              comp: '/api/admin/competitions',
              event: '/api/admin/events',
              market: '/api/admin/markets',
              sel: '/api/admin/selections',
            }[kind];
            await api('POST', path, payload);
            toast(`${kind} created`);
            form.reset();
            renderCreateView();
            refreshAll();
          } catch (e) {
            toast(e.message, 'err');
          }
          btn.disabled = false;
        };
      });
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  window.OBAdmin = { render };
})();
