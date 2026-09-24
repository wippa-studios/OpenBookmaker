# API reference

Base URL `http://127.0.0.1:7777` (loopback only). All responses are JSON; errors
are `{ "error": "..." }`. A `4xx` message is safe to show a user; anything
`5xx` is logged server-side and replaced with `Internal error`.

**Authentication.** `POST /api/auth/register` and `/api/auth/login` set an
`ob_session` httpOnly cookie (`SameSite=Lax`). Send it on later requests, or use
`Authorization: Bearer <token>` where a cookie jar is awkward (curl `-c/-b`, test
clients). `GET /api/me` returns the current user.

**Origin guard.** Any `POST`/`PUT`/`PATCH`/`DELETE` is rejected `403` unless it
carries no `Origin` (local tooling) or a loopback/same-host one. The guard runs
before body parsing, so a malformed body from elsewhere is still `403`.

**Money** is always integer cents in every field named `*_cents`. Prices are
decimal odds; the server snaps them to the ladder and never rejects a price for
being off-ladder.

---

## Public

### `POST /api/auth/register`

```json
{ "username": "joel", "password": "secret1" }
```

Creates an account with a zero balance (top up from the faucet) and signs it in.
`201` → `{ "user": { "id": 1, "username": "joel", "is_admin": false, "is_bot": false, "balance_cents": 0, "frozen_cents": 0 } }`.
`400` invalid username (3–32 chars: letters, digits, `_`, `-`) or password
(<6 chars), `409` username taken.

### `POST /api/auth/login`

`{ "username": "joel", "password": "secret1" }` → `200` `{ "user": {...} }` and a
session cookie. `401` for an unknown user, a wrong password, or a bot account
(one generic message, constant-time).

### `POST /api/auth/logout`

Deletes the session, clears the cookie → `{ "ok": true }`.

### `GET /api/me`

`200` → `{ "user": { ..., "available_cents": 97500 } }` where
`available = balance − frozen`. `401` without a session.

### `GET /api/sports`

`200` → `{ "sports": [{ "id": 1, "name": "Football", "slug": "football", "event_count": 5 }] }`.

### `GET /api/events`

Optional `?sport=<slug>`. Only `upcoming` and `live` events; each event carries
its markets and, per market, a 3-level book per runner.

```json
{ "events": [{
  "id": 1, "name": "Arsenal vs Chelsea", "sport": "Football",
  "competition": "Premier League", "starts_at": "2026-09-25 18:00:00",
  "status": "upcoming",
  "markets": [{
    "id": 1, "name": "Match Odds", "status": "open", "total_matched_cents": 20000,
    "selections": [{
      "selection_id": 1, "name": "Arsenal", "status": "open", "ltp": 2.4,
      "back": [{ "price": 2.46, "size_cents": 3812 }],   // resting LAYS, highest first
      "lay":  [{ "price": 2.44, "size_cents": 8021 }]    // resting BACKS, lowest first
    }]
  }]
}] }
```

`back` is what a backer can bet into (resting lay offers, best = highest);
`lay` is what a layer can bet into (resting back offers, best = lowest). `ltp`
is `null` until the runner trades.

### `GET /api/markets/:id/book`

Same `book` shape at 5 levels. `404` unknown market.

### `POST /api/orders`

```json
{ "selection_id": 1, "side": "back", "price": 2.4, "stake_cents": 10000 }
```

Limit order: matches eligible resting liquidity, then the remainder rests.
`201` →

```json
{ "order": { "id": 9, "status": "open", "price": 2.4, "stake_cents": 10000, "matched_cents": 6000 },
  "fills": [{ "price": 2.4, "stake_cents": 6000 }],
  "book": [ /* refreshed book */ ] }
```

`order.status` is `open` (has a remainder), `fully_matched` or `cancelled`.
Errors: `400` invalid side/stake/price or insufficient available balance for the
escrow, `404` unknown selection, `409` market not open / selection suspended /
event completed.

### `GET /api/orders`

Your unmatched orders. `200` → `{ "orders": [{ "id": 9, "side": "back", "price": 2.4, "stake_cents": 10000, "matched_cents": 6000, "selection_name": "Arsenal", "market_name": "Match Odds", "event_name": "..." } ] }`.

### `POST /api/orders/:id/cancel`

Releases the escrow on the unmatched remainder. `200` → `{ "order": {...} }`.
`400` already cancelled or fully matched, `404` not your order.

### `GET /api/positions`

Matched exposure, if-win P&L, and whether a cash-out is executable.

```json
{ "positions": [{
  "market_id": 1, "market_name": "Match Odds", "event_name": "Arsenal vs Chelsea",
  "market_status": "open", "winner_selection_id": null,
  "selections": [{ "selection_id": 1, "name": "Arsenal",
    "my_back_stake_cents": 10000, "my_lay_stake_cents": 0, "frozen_cents": 10000 }],
  "pnl_if_win": [{ "selection_id": 1, "name": "Arsenal", "pnl_cents": 15000 },
                 { "selection_id": 2, "name": "Chelsea", "pnl_cents": -10000 }],
  "cashout": { "selection_id": 1, "my_side": "back", "hedge_side": "lay",
               "hedge_price": 1.9, "hedge_stake_cents": 10526, "value_cents": 526 }
}] }
```

`pnl_if_win[i]` is your P&L if runner *i* wins (before commission, which is
charged at settlement). `cashout` is `null` when not supported or not
executable. Only markets where you hold a **matched** position appear.

### `POST /api/markets/:id/cashout`

Closes your single-runner, single-side position at top of book, all-or-nothing.
`200` → `{ "hedge_order": {...}, "fills": [...], "value_cents": 526, "hedge_price": 1.9, "my_side": "back" }`.
`409` no eligible position, mixed/multi-runner, no liquidity, or the hedge
cannot fill completely (nothing is written in that case).

### `GET /api/wallet`

`200` → `{ "balance_cents": 100000, "frozen_cents": 10000, "available_cents": 90000, "transactions": [ { "type": "escrow", "amount_cents": 10000, "balance_after": 100000, "frozen_after": 10000, "order_id": 9, "market_id": 1, "at": "..." } ] }`.

Transaction types: `deposit`, `escrow` (freeze), `release` (unfreeze), `settle`
(net P&L, may be negative), `commission`, `refund` (void).

### `POST /api/wallet/deposit`

`{ "amount_cents": 10000 }` (fountain; cap `FAUCET_MAX_CENTS`) → `200` `{ "balance_cents": ..., "frozen_cents": ... }`. `400` not a positive integer or over the cap.

### `GET /api/settlements`

`200` → `{ "settlements": [{ "market_id": 1, "market_name": "Match Odds", "event_name": "...", "selection_name": "Arsenal", "credit_cents": 20000, "commission_cents": 375, "pnl_cents": 15000, "at": "..." }] }`. `selection_name` is `null` for a void.

### `GET /api/format/:price`

`200` → `{ "decimal": 2.5, "american": "+150", "fractional": "3/2", "implied_prob": 0.4 }`. The price is snapped to the ladder first (an off-ladder `2.75` comes back as a valid tick). `400` non-numeric or outside the ladder.

### `GET /api/stream`

Server-sent events. Each message is `event: <name>` with a JSON `data` payload:

| Event | Sent to | Data |
| --- | --- | --- |
| `book` | everyone | `{ "market_id": 1 }` — refetch the book |
| `balance` | the user | `{}` — your balance or escrow changed |
| `orders` | the user | `{}` — your open orders changed |
| `settlement` | everyone | `{ "market_id": 1 }` |

A `: hb` comment is sent every 15s to keep intermediaries from dropping an idle
stream. Connect with `EventSource('/api/stream')`; it reconnects on its own, and
the client refetches on every event (a 15s poll is the fallback).

---

## Admin (requires a user with `is_admin`)

All admin routes answer `401` without a session and `403` for a non-admin.

### `POST /api/admin/sports` — `{ "name": "Football" }`

Creates a sport (slug derived from the name). `201` `{ "sport": {...} }`, `409` slug exists.

### `POST /api/admin/competitions` — `{ "sport_id": 1, "name": "Premier League", "country": "ENG" }`

`201` `{ "competition": {...} }`, `400` invalid `sport_id`.

### `GET /api/admin/competitions?sport_id=1`

`200` → `{ "competitions": [{ "id": 1, "name": "Premier League", "country": "ENG" }] }`. `400` missing `sport_id`.

### `POST /api/admin/events` — `{ "sport_id": 1, "competition_id": 2, "name": "Arsenal vs Chelsea", "starts_at": "2026-09-25 18:00" }`

`starts_at` is stored as given and displayed as UTC. `competition_id` is optional but, if given, must belong to `sport_id`. `201` `{ "event": {...} }`.

### `POST /api/admin/markets` — `{ "event_id": 1, "name": "Match Odds" }` → `201` `{ "market": {...} }`

### `POST /api/admin/selections` — `{ "market_id": 1, "name": "Arsenal", "fair_price": 2.4 }`

`fair_price` is optional and snapped to the ladder. If given, the bot quotes a
three-tick ladder around it immediately; if omitted, the runner gets **no** bot
liquidity (useful for a market you want to trade by hand). `201`
`{ "selection": {...} }`.

### `PATCH /api/admin/markets/:id` — `{ "status": "suspended" }`

`open` or `suspended`. `400` other value, `404` unknown, `409` already settled.

### `POST /api/admin/markets/:id/settle`

Exactly one of: `{ "winner_selection_id": 12 }` or `{ "void": true }`. Input is
validated strictly (a string `"false"` is not a boolean, `true` is not a
selection id, and both together is `400`). Settling distributes every matched
pot, charges commission on net winnings, auto-cancels unmatched orders, and
freezes the market. `200` →

```json
{ "market": { "status": "settled", "winner_selection_id": 12 },
  "per_user": [{ "user_id": 2, "pnl_cents": 15000, "commission_cents": 375 }] }
```

`404` unknown market, `409` already settled, `400` bad input or a winner from a
different market.

### `GET /api/admin/stats`

`200` → `{ "markets": [{ "id": 1, "name": "Match Odds", "event_name": "...", "status": "open", "total_matched_cents": 0, "open_orders": 2, "overround": -0.0123 }] }`

`overround` is Σ implied probability of the best price a backer can get on every
runner, minus 1: **negative** means the runners can all be backed for a guaranteed
profit (arbitrage), positive means the market is margined, `null` means some
runner has no available price.

---

## Errors

| Status | Meaning |
| --- | --- |
| `400` | invalid input from the client (never a money invariant) |
| `401` | no session, or bad credentials |
| `403` | wrong role, or a foreign `Origin` on a mutating request |
| `404` | unknown id, or not your order |
| `409` | state conflict: market not open, already settled, stale intent |
| `413` | body over 256 kB |
| `500` | internal error — logged with detail, reported as `Internal error` |
