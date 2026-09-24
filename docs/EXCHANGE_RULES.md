# Exchange rules

The behavioural specification: who can bet, at what price, who wins, who pays
what. Every number here is asserted by a test; the test file is named next to
each rule so you can check the arithmetic yourself.

- [Vocabulary](#vocabulary)
- [Prices and the tick ladder](#prices-and-the-tick-ladder)
- [Placing an order](#placing-an-order)
- [Matching](#matching)
- [Escrow](#escrow)
- [Settlement](#settlement)
- [Commission](#commission)
- [Voiding](#voiding)
- [Cash-out](#cash-out)
- [Markets, events and lifecycle](#markets-events-and-lifecycle)
- [Limits and configuration](#limits-and-configuration)
- [What is deliberately not implemented](#what-is-deliberately-not-implemented)

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Back** | Betting that a runner **wins**. Risk = the stake. Win = `stake × (price − 1)`. |
| **Lay** | Betting that a runner **loses**. You accept someone else's stake. Risk = `(price − 1) × stake`; win = the stake. |
| **Stake** | Always expressed in **backer-stake units**: the amount a backer would put in, whatever side you are on. A lay of 100 @ 2.50 accepts 100 of backer stake and risks 150. |
| **Price** | Decimal odds, on the ladder, two decimal places. |
| **Runner / selection** | One outcome inside a market (a team, a player, a trap). |
| **Market** | A set of runners on one event, exactly one of which wins. |
| **LTP** | Last traded price. Only real trades move it — never the bots' quotes or the drift. |
| **Matched** | Executed. **Unmatched** remainder stays on the book as a limit order. |

## Prices and the tick ladder

Prices are decimal odds and must sit on the Betfair ladder:

| Range | Step | | Range | Step |
| --- | --- | --- | --- | --- |
| 1.01 – 2.00 | 0.01 | | 10.5 – 20 | 0.5 |
| 2.02 – 3.00 | 0.02 | | 21 – 30 | 1 |
| 3.05 – 4.00 | 0.05 | | 32 – 50 | 2 |
| 4.10 – 6.00 | 0.10 | | 55 – 100 | 5 |
| 6.20 – 10.0 | 0.20 | | 110 – 1000 | 10 |

The gaps between bands are real: 2.01, 10.2 and 100.5 are **not** prices, and
`lib/odds.js` snaps anything else to the nearest valid tick (ties round up inside
a band, and to the lower band edge in a gap). `valid = snapToTick(p) === p`.

The server is the authority. It re-snaps every price it accepts, so a
hand-typed price is never rejected for being off-ladder — it is corrected.
`GET /api/format/:price` returns the same ladder's value in decimal, American,
fractional and implied-probability form; the admin desk uses it so a trader never
sees a conversion the engine would not agree with.

*Tests:* `tests/odds.test.js` (T1–T10), `tests/seed.test.js` (S3).

## Placing an order

1. A session is required; the selection and its market must be `open`, the
   event must not be `completed`.
2. Stake must be an **integer number of cents** within
   `[MIN_STAKE_CENTS, MAX_STAKE_CENTS]`. Strings and floats are rejected at the
   boundary (`Number("100")` and `Number(true)` are not stakes).
3. The price is snapped to the ladder and must land in `[1.01, 1000]`.
4. The required escrow must be available (see below). If it is not, **nothing is
   written** — no order, no match, no ledger row.
5. The order is inserted first, then matched, then any remainder rests.

An order is a **limit order**: it takes liquidity immediately at the resting
prices, and the rest sits on the book until cancelled or settled. It is never
filled at your limit price if better resting liquidity exists.

*Tests:* `tests/match.test.js` (E9 validation), `tests/tx.test.js` (X6
all-or-nothing).

## Matching

For a taker and a resting order to trade, the resting order's price must satisfy
the taker's limit — and the trade happens **at the resting price**, never at the
taker's price or some midpoint.

| Taker | Eligible resting orders | Swept in this order | Filled at |
| --- | --- | --- | --- |
| **Back @ P** | lays with `Q ≥ P` | **highest Q first** (best price for the backer) | the resting `Q` |
| **Lay @ Q** | backs with `P ≤ Q` | **lowest P first** (least liability for the layer) | the resting `P` |

- **Price-time priority**: within one price level, the order that rested longer
  fills first (`ORDER BY price, id`).
- **Partial fills** are the norm. Remainder keeps resting.
- **Self-match guard**: a user's own resting orders are skipped, so you cannot
  lay yourself. This also means your own displayed liquidity is not executable
  against you — which is why cash-out quotes ignore it.
- The book is kept consistent by construction: a resting back and a resting lay
  can never price-cross, because whichever arrived second would have matched.

*Tests:* `tests/match.test.js` — E1 (resting price stands), E2 (partial fill),
E4 (back sweep highest-first), E5 (lay sweep lowest-first), E13 (FIFO within a
level), E6 (self-match guard), E11 (aggregation and ordering).

## Escrow

Funds move in two directions, and escrow is what stops either side spending money
twice:

| Event | Backer | Layer |
| --- | --- | --- |
| Place a back | freeze `stake` | — |
| Place a lay @ Q | — | freeze `(Q − 1) × stake` |
| Match a lay at resting `P ≤ Q` | — | release `(Q − P) × fill`, leaving `(P − 1) × fill` frozen |
| Cancel the remainder | release the remainder | release `(price − 1) × remainder` |
| Settle | consume `stake` | consume `(P − 1) × stake` |

`available = balance − frozen`. A user can never place an order their available
balance cannot cover, and `frozen_cents` can never go negative (guarded in
`lib/ledger.js` and again by a database `CHECK`).

*Tests:* `tests/ledger.test.js` (L2–L3), `tests/match.test.js` (E3, E7, E8),
`tests/store.test.js` (D3).

## Settlement

A market is settled exactly once, by an admin, with either a **winning runner**
or `void: true`. The input is validated strictly — `void: "false"` is not a
boolean, `true` is not a selection id, and both at once is contradictory.

For a match of stake `s` at price `Q`, the pot is `s + (Q−1)·s = s·Q`:

| Outcome | Backer | Layer |
| --- | --- | --- |
| Backer's runner won | unfreeze `s`, gain `(Q−1)·s` | lose `(Q−1)·s` |
| Layer's runner won | lose `s` | unfreeze `(Q−1)·s`, gain `s` |
| Void | refunded `s` | refunded `(Q−1)·s` |

Then, per user per market:

- `net = Σ wins − Σ losses`
- `commission = round(net × COMMISSION_RATE)` **only when `net > 0`**
- balance moves by `net − commission`; escrow for the market is released

Before that, every **unmatched** order in the market is auto-cancelled and its
remainder escrow released, and the event becomes `completed` when all of its
markets are settled. A settled market is frozen: it rejects new orders and
cannot be settled again.

**Conservation**: the sum of every balance change in a settlement equals
`−(total commission)`. There is no other source or sink — the exchange takes the
commission and nothing else. This is asserted end-to-end in `tests/smoke.sh`
(`100000 − 375 = 99625` across two players).

*Tests:* `tests/settle.test.js` (S1–S11), `tests/smoke.sh` (conservation),
`tests/api.test.js` (settled market frozen).

## Commission

A single rate (`COMMISSION_RATE`, default 2.5%) charged on **net winnings per
user per market**, at settlement — not per bet, not on stake, and not on gross
turnover. Winning one market and losing another in the same session nets out
before the fee is taken.

The one rounding point per fee is `Math.round(net × rate)`. Commission on the
net (rather than per match) is deliberate: for 5050 + 5050 of winnings the fee is
`round(10100 × 0.025) = 253`, not `126 + 126 = 252`.

*Tests:* `tests/settle.test.js` (S7).

## Voiding

`void: true` means the event did not produce a result (cancelled, postponed,
abandoned). Every matched stake returns to the person who committed it — a
backer gets their stake, a layer gets their liability — and nobody pays
commission. Voiding is visible in the wallet as a `refund` transaction and in
history as a settlement with zero P&L.

A void refunds the liability **at the match price**, which is what the escrow
actually froze. A layer who offered at 2.10 and matched at 2.00 was refunded
1500, not 1100, because the extra 100 was already released when the better fill
happened.

*Tests:* `tests/settle.test.js` (S4, S10).

## Cash-out

Cash-out closes a matched position by trading against the book, so it only works
while the position can be offset — and it is all-or-nothing.

**When it is offered** (v1): the position is a single runner, single side, the
market is open, and the opposite side of the book has enough non-self liquidity.

**The hedge**: to close a position at current price `n`, place an order of size

```
hedge = round( Σ (stake_i × entryPrice_i) / n )
```

The division by the **current** price is the whole trick — the hedge stake scales
as `1/n`, which is why their green-up maths is not symmetric.

**The locked value** (identical regardless of the outcome, within a cent of
rounding):

- closing a **back** `L` = hedge stake, value `L − Σ stake_i`
- closing a **lay** `B` = hedge stake, value `Σ stake_i − B`

Worked example — back 10000 @ 2.00, price drifts in to 1.90:

```
numer = 10000 × 2.00 = 20000
hedge  = round(20000 / 1.90) = 10526
value  = 10526 − 10000 = 526      (i.e. $5.26, the house formula 100 × (2.0−1.9)/1.9)
```

The hedge is a lay of 10526 @ 1.90, which escrows `round(0.9 × 10526) = 9473`.
After it, the position pays 3333 if the runner wins and 3333 if it loses — green
to within the single cent of rounding, and the trader's 526 is guaranteed.

If the hedge cannot fill **completely**, the whole cash-out is rolled back and
the request is rejected: you are never left half-closed.

*Tests:* `tests/cashout.test.js` (C1–C8).

## Markets, events and lifecycle

```
sport ──< competition ──< event ──< market ──< runner
                                      │
                        open ──suspended──open
                          │
                       settled   (terminal: winner | void)
```

- **open** — orders accepted, ladders quoted.
- **suspended** — orders rejected, existing orders still rest (a trader pulls a
  market, or the desk does).
- **settled** — frozen. The winner (or void) is recorded, escrow is distributed,
  and nothing can be placed or settled again.
- An event is **completed** when all of its markets are settled.
- Events whose start time has passed roll from `upcoming` to `live` at boot, so a
  demo left running does not slowly empty its own board.

## Limits and configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `MIN_STAKE_CENTS` / `MAX_STAKE_CENTS` | 100 / 100000 | order size bounds, inclusive |
| `COMMISSION_RATE` | 0.025 | fee on net winnings, 0–0.2 |
| `FAUCET_MAX_CENTS` | 100000 | cap per faucet deposit |
| `DRIFT_INTERVAL_MS` | 5000 | how often a fair price moves |
| `BOT_ENABLED` / `DRIFT_ENABLED` | true | demo liquidity and price movement |
| `SESSION_TTL_DAYS` | 30 | session lifetime |

A runner created **without** a fair price is never quoted by the bots — that is
how you build a market with no demo liquidity in it.

## What is deliberately not implemented

Listed so nobody mistakes a scope decision for a bug:

- **Accumulators / parlays.** One selection per order.
- **Each-way betting.** Win markets only.
- **In-play bet delay, partial-fill queueing, cross-market matching.** A taker
  takes resting liquidity immediately and then rests its remainder.
- **A results feed.** Settlement is a manual admin action; the feed would call
  the same `settleMarket`.
- **Multi-runner or mixed cash-out.** Those positions are traded manually.
- **Real money.** No payment, withdrawal, KYC/AML or licensing path exists, and
  the seeded bot's fair prices are a random walk rather than a model.
