# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-09-25

### Added
- Betfair-style ladder UI: three back prices, runner + LTP, three lay prices
  per runner, with green/red price-change flashes fed by SSE.
- Bet slip with tick steppers, typed prices snapped to the ladder, live
  profit/liability preview, and per-order placement.
- "My bets": open orders with cancel, matched positions with the if-win P&L
  matrix and cash-out, settled history with commission.
- Wallet: available vs frozen balances, faucet deposits, full transaction ledger.
- Admin trading desk: catalogue creation, suspend/restore, settle dialog
  (winner or void), per-market matched volume and open-order counts, live
  fair-price helper showing American/fractional/implied from the server, and a
  per-market overround (margin or arbitrage) signal.
- Verification: a live end-to-end smoke script (33 checks) and a real-browser
  Playwright suite (24 checks, including ladder geometry, the admin desk and
  zero page errors).
- `GET /api/format/:price` and `GET /api/settlements`; `GET /api/admin/competitions`.
- Repository process: contributing guide, security policy, code of conduct,
  changelog, issue and PR templates, `.editorconfig`, `.nvmrc`.
- `docs/ARCHITECTURE.md`, `docs/EXCHANGE_RULES.md` and `docs/API.md`;
  `docs/screenshot.png` as the board image.

### Security
- `HOST` is validated as loopback-only; a routable bind now aborts the launch.
- Origin guard moved ahead of body parsing so a foreign origin is rejected even
  with a malformed body.
- 5xx responses return a generic message; internals only reach the log.
- Constant-time login for unknown users; expired sessions purged at boot.
- `nosniff` and `same-origin` referrer headers; JSON `404` for `/api/*`.

### Fixed
- Settlement input is validated strictly — `void: "false"` no longer voids a
  market and a boolean can no longer become a selection id.
- Cash-out quotes exclude the caller's own resting orders and pre-validate
  stake, escrow and balance, so a quoted cash-out is executable.
- Drift requotes only the runner whose fair price moved instead of every order
  in the market.
- A fair-priced runner created at runtime is quoted immediately.
- Bet-slip DOM race: rows update in place instead of being rebuilt from inside
  their own input's change handler (fixes `NotFoundError`, preserves focus).
- Ladder layout: each price side is a column stack (CSS grid auto-placement is
  row-major, which had scattered the three prices of a side across columns).
- Typed slip prices are honoured; enum values escaped; async renderers re-check
  container connectivity; the SSE stream rebinds on sign-in/out.
- Seeded fair prices are stored on the ladder (a hand-written `2.75` is not a
  tick in the `2.02–3.00` band).

### Changed
- Money column `CHECK` constraints in SQLite: non-negative integer cents,
  `matched <= stake`, price within the ladder range.
- `registerUser` rejects fractional or negative opening balances.
- Transaction handling centralised in `lib/tx.js` (nested calls use savepoints);
  `placeOrderTx` refuses to run outside a transaction.
- `GET /api/format/:price` and per-market overround on the admin stats are now
  backed by the existing, tested pricing library rather than sitting unused.
- Past-due seeded events roll forward to `live` at boot.
- Board hygiene: past-due fixtures roll forward to `live` at boot.

## [0.1.0] - 2026-09-24

### Added
- Exchange core: order book, matching engine with best-for-taker sweeps and
  partial fills, liability escrow, settlement with commission, cash-out.
- Seeded liquidity bots and a fair-price drift loop.
- REST API, SSE stream, sessions, admin routes, 78-check test suite.
