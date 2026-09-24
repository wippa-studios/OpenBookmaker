# Contributing to OpenBookmaker

Thanks for looking at this. It is a small project with one hard rule: **the
money must balance**. Everything else is negotiable; that is not.

## The one rule

Every cent has to be accounted for. If your change can move a balance, freeze a
balance, pay a commission or a payout, it needs a test that proves the
arithmetic with hand-computed numbers, and it must not introduce a second
rounding step. The invariants are listed in the README and specified in
[`docs/EXCHANGE_RULES.md`](docs/EXCHANGE_RULES.md). If you cannot state which
invariant your change preserves, do not merge it.

## Getting set up

```bash
git clone https://github.com/wippa-studios/OpenBookmaker.git
cd OpenBookmaker
npm install                 # express is the only runtime dependency
cp .env.example .env        # optional; defaults are fine
npm run seed && npm start   # http://127.0.0.1:7777
```

Requires **Node 22.13+** (`.nvmrc` is set). There is no build step for the
frontend: `public/` is plain HTML/CSS/classic JS, edited and reloaded directly.

Sign in as `demo` / `demo123`, or `admin` / `admin123` for the trading desk.

## Before you open a pull request

```bash
npm test            # 96 checks: unit + API integration, fully offline
npm run test:smoke  # 33 checks: live end-to-end against a real server
npm run test:ui     # 22 checks: real Chromium via Playwright (frontend changes)
```

All three run offline: temporary or in-memory databases, an ephemeral port, and
the drift loop disabled. Nothing needs credentials or a network.

## House conventions

These are inherited from the project this was modelled on, and matching them
keeps diffs small and review fast:

- **Tests are plain `assert`**, run standalone (`node tests/foo.test.js`), with
  numbered examples (`E1`, `S4`, `C2`…) and a `check(name, fn)` helper that
  counts. No test framework, no snapshots, no mocks. `npm test` chains them in
  dependency order.
- **Comments explain why, not what.** The code says what it does; a comment earns
  its place by explaining the rule, the invariant or the trap.
- **Money is integer cents**, with a single `Math.round` per liability, payout or
  fee — never a second rounding on the way to the screen.
- **Browser scripts are IIFEs** with at most one global each (`window.OB`,
  `window.OBAdmin`). Classic scripts share a single global scope: a top-level
  `const` collision between two files is a `SyntaxError` that kills the later
  script, not a lint warning.
- **Every server string is escaped** before it reaches `innerHTML` (`esc()`),
  because sport, event and runner names are admin-authored.
- **Validation at the boundary**: routes validate, services validate again if the
  service is reachable from elsewhere, and the database enforces the cents
  invariants with `CHECK` constraints.
- **Transactions go through `lib/tx.js`.** Do not hand-roll `BEGIN`/`COMMIT`.

## Adding things

**A new market type** (e.g. handicaps, place-pot): a market is a row with
selections under it, so usually this is a seed/fixture change plus a naming
convention for the market. The engine is side-agnostic — a market type that is
still one runner winning still settles through `lib/settle.js` unchanged.

**A new price format or ladder band**: `lib/odds.js` is the single source of
truth, including for the browser (`public/app.js` mirrors the ladder for the
slip steppers; the server re-snaps everything it accepts, so the mirror can
never corrupt a trade). Add the band to `LADDER` and to the browser mirror, and
extend `tests/odds.test.js`.

**A new API route**: add it to `server.js` with the existing guards
(`requireAuth`/`requireAdmin`), sanitise the error path (5xx messages are
replaced with a generic string by `errorHandler`), document it in the README
table, and add a positive and a negative test in `tests/api.test.js`.

**Cash-out or settlement changes**: read `docs/EXCHANGE_RULES.md` first, then
`tests/cashout.test.js` and `tests/settle.test.js` — they already encode the
hand-computed examples you will need to preserve.

## Commit and PR conventions

- One logical change per commit; the message explains the change and the reason,
  not the file list.
- Reference the issue (`Closes #12`).
- Use the PR template checklist. If a box cannot be ticked, say why in the PR.
- The smoke test must stay green. If you need to change an expectation there,
  the old and new numbers should both be explainable by the arithmetic.

## Reporting bugs

Use the issue templates. If a bug affects balances, escrow, settlement,
commission or cash-out, say so in the template — those are triaged first,
because on a betting engine a money bug is worse than a broken button.

## Security issues

Do **not** open a public issue. See [`.github/SECURITY.md`](.github/SECURITY.md).

## Licence

By contributing you agree that your work is licensed under the [MIT
licence](LICENSE).
