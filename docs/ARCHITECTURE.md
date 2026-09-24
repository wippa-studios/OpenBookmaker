# Architecture

This is the design a maintainer needs before changing the engine. For the
behavioural rules (who wins, who pays what), see
[`EXCHANGE_RULES.md`](EXCHANGE_RULES.md).

## Shape of the system

```
browser (public/)
  index.html  app.js  admin.js  style.css        classic scripts, no build step
      │  fetch() + EventSource                    same-origin, cookie session
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ server.js                                                       ~510  │
│   1. baseline security headers                                     │
│   2. origin guard (BEFORE any body parsing)                        │
│   3. express.json({ limit: 256kb })                                 │
│   4. session middleware  (cookie ob_session | Bearer)               │
│   5. routes: auth · board · trading · wallet · admin · stream       │
│   6. /api 404 (JSON) → static(public/) → errorHandler               │
└──────────────────────────────────────────────────────────────────────┘
      │                    ▲                              │
      ▼                    │ broadcast()                  │ lib/tx.js
  node:sqlite (WAL) ── lib/*.js                          │ one transaction
  data/openbookmaker.db                                  │ discipline
```

There is no ORM, no migration framework and no service layer beyond `lib/`. The
schema is a single `CREATE TABLE IF NOT EXISTS` block in `lib/store.js` (13
tables), which is why a fresh clone runs with one command. Express is the only
runtime dependency; Playwright is dev-only and used by the browser suite.

## Modules and their responsibilities

| Module | Owns | Must not |
| --- | --- | --- |
| `lib/tx.js` | transaction depth; nested calls become savepoints | know anything about betting |
| `lib/store.js` | schema, pragmas, connection | contain domain logic |
| `lib/config.js` | `.env` parsing, validation, loopback enforcement | read `process.env` outside the loader |
| `lib/odds.js` | tick ladder, snap/next/prev, American/fractional, implied probability, overround | know about orders or balances |
| `lib/auth.js` | scrypt hashing, sessions, sanitised user shape | touch balances |
| `lib/ledger.js` | the only writer of balances/escrow and `transactions` rows | decide who wins |
| `lib/match.js` | order validation, book sweeps, fills, `bookFor`, positions, overround | settle anything |
| `lib/settle.js` | market settlement: pot distribution, commission, void, auto-cancel | place orders |
| `lib/cashout.js` | quote + execute a green-up close | touch the raw pot maths |
| `lib/bots.js` | MarketMakers ladders, requote | match itself (the engine's self-match guard covers it) |
| `lib/drift.js` | fair-price random walk | move LTP (only real trades do) |
| `lib/seed.js` | first-run fixtures, board roll-forward | run on every boot unconditionally |

The dependency direction is strictly one way: `match → ledger → tx`, and
`settle/cashout → match`. Nothing imports `server.js`.

## The money path, end to end

A single back order that matches, from click to settlement:

1. **Route** `POST /api/orders` validates the body, requires a session, and
   calls `match.placeOrder`.
2. **`placeOrder`** opens a transaction (`lib/tx.js`) and calls `placeOrderTx`.
3. **`placeOrderTx`** validates against the *current* market/selection state,
   asks the ledger to freeze `stake` (a back) or `(price−1) × stake` (a lay),
   inserts the order, then sweeps eligible resting orders:
   - a back taker takes resting **lays** with `Q ≥ P`, highest price first;
   - a lay taker takes resting **backs** with `P ≤ Q`, lowest price first;
   - each fill records a `matches` row **at the resting order's price**;
   - a lay that matches better than its own price releases the excess escrow.
   Any remainder stays on the book. LTP, the trade tape and
   `total_matched_cents` update inside the same transaction.
4. **Broadcast** sends `book` to everyone and `orders`/`balance` to that user.
5. **Settlement** (`settle.settleMarket`) validates the admin's intent strictly,
   freezes the market, auto-cancels unmatched orders (releasing escrow), then
   walks every match: the winner's side is credited the pot, void refunds each
   side its own contribution, commission is charged on net winnings per user, and
   the event completes when all of its markets are settled.
6. The wallet is only ever mutated through `ledger.js`, and every mutation
   writes a `transactions` row carrying `balance_after` and `frozen_after`.

## Why these choices

- **No ORM, no migrations.** The schema is thirteen tables (plus SQLite's own
  `sqlite_sequence`) of plain SQL with
  `CHECK` constraints on the money columns. A contributor can read the whole
  data model in one file, and the database itself refuses an invalid cent.
- **`node:sqlite` instead of a native driver.** No compilation, no prebuilt
  binary to mismatch the platform, nothing to audit in the dependency tree. The
  `ExperimentalWarning` is suppressed by `--no-warnings` in the npm scripts.
- **One transaction helper.** SQLite has no nested `BEGIN` and `node:sqlite`
  cannot tell you whether you are already in one, so depth is tracked in
  `lib/tx.js` and every atomic unit goes through it. `placeOrderTx` is the only
  exported function that assumes a caller-owned transaction, and it checks.
- **Escrow in the database, not in memory.** A crash between "matched" and
  "settled" is survivable because the escrow is a column, not a process-local
  counter.
- **SSE plus a 15s poll fallback in the browser.** The stream is a nicety; the
  board must still move if a proxy drops it.
- **Bots as ordinary users.** `is_bot` is a flag, not a code path: the bot's
  orders go through the same engine as a human's, and the self-match guard is
  what stops its own two sides from crossing.

## Data model

```
sports ──< competitions ──< events ──< markets ──< selections
                                                  │        │
users ──< orders >───────────────────────────────┘        │
  │        │  └──< matches >──┘                             │
  │        └──< transactions                                 │
  └──< sessions                                              │
                                    price_history, settlements, settings
```

`orders` is the book *and* the user's history in one table (`status` is
`open` / `fully_matched` / `cancelled`); `matches` is the executed trade tape and
is what settlement reads. `settlements` is a precomputed per-user-per-market
outcome so history is a single indexed read.

Index notes: `orders(selection_id, side, price, id)` serves the book sweep
directly (including the FIFO tiebreak), `orders(user_id, status)` serves the open
orders list, and `matches(market_id)` serves settlement.

## Security model

Deliberately narrow, and asserted by tests rather than assumed:

- **Loopback only.** `config.js` refuses a routable `HOST` at boot; the test
  server binds `127.0.0.1` explicitly.
- **Origin guard before parsing.** Mutating requests need no `Origin` (curl) or a
  loopback origin. Because it runs first, a malformed body from a foreign origin
  is still a `403`.
- **Sessions** are opaque 32-byte tokens in SQLite, delivered in an
  `HttpOnly; SameSite=Lax` cookie. Passwords are scrypt + `timingSafeEqual`, and
  a missing user still pays the KDF cost.
- **Error discipline.** 4xx messages are ours and safe; anything 5xx is logged
  and replaced with `Internal error` before it reaches a client.
- **No secrets in the repo.** The demo credentials are deliberate and documented;
  the GitHub token used during development lives outside the repository.

## Testing strategy

| Layer | Where | What it proves |
| --- | --- | --- |
| Pure maths | `tests/odds.test.js`, `tests/tx.test.js` | ladder, conversions, transaction depth |
| Schema | `tests/store.test.js` | tables, foreign keys, money `CHECK`s |
| Fixtures | `tests/seed.test.js` | idempotent seed, valid fair prices, board roll-forward |
| Services | `tests/{auth,ledger,match,settle,cashout}.test.js` | the money rules, hand-computed |
| HTTP | `tests/api.test.js` | the wire contract, guards, error sanitisation |
| Live | `tests/smoke.sh` | a real server, real HTTP, real conservation |
| Browser | `tests/ui_test.mjs` | the UI renders and *behaves*, no page errors |

The domain suites are pure `assert` with numbered examples and no framework, so
a single file can be read end-to-end as executable specification. The browser
suite asserts **geometry**, not just presence: a ladder that renders the wrong
number of cells can still look right in a screenshot, but a mis-stacked price
column cannot pass the x/y assertions.

## Extension points

- **New market shapes**: add rows; the engine is side-agnostic and settlement
  only needs a winning selection per market.
- **A real results feed**: replace the admin settle call with a feed consumer —
  `settleMarket` is already the single, idempotent, audited entry point.
- **Multi-runner cash-out**: `lib/cashout.js` computes per-runner hedges; netting
  several runners is a change to plan construction, not to the engine.
- **A real matching venue in front**: the engine's sweep, price-time priority and
  self-match guard are the parts you would keep; settlement and the ledger are
  independent of them.
EOF