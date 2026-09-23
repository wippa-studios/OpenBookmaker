# OpenBookmaker

**An open-source Betfair-style betting exchange** — back/lay order books with a
real matching engine (price-time priority, partial fills), Betfair tick-ladder
pricing, liability escrow, market settlement with commission, cash-out, and
seeded liquidity bots so the exchange is always tradeable.

**Paper money only.** Like a demo account: every user starts with a play-money
balance and a faucet can top it up. There is no real-money path anywhere in
this codebase.

> ⚠️ Educational/demo software. Operating a real-money betting exchange
> requires licensing and regulatory compliance (18+, responsible gambling).
> This project deliberately ships none of that.

## What it does

- **Order book per selection** — resting lay offers (what you can back) and
  resting back offers (what you can lay into), depth-quoted, always live.
- **Matching engine** — best-for-taker sweeps, match at the resting price,
  partial fills, remainder rests, self-match guard.
- **Escrow wallet** — backers freeze their stake, layers freeze their
  liability; available vs frozen balance, full transaction ledger.
- **Settlement with commission** — market result distributes the pot; winners
  paid, commission charged on net winnings per user per market.
- **Cash-out** — close a single-selection position at top of book with the
  classic green-up math.
- **Liquidity bots + drift** — seeded MarketMakers quote a ~3-tick spread
  around a fair price and reprice as the fair drifts, so the demo feels alive.

## Quick start

```bash
npm install
cp .env.example .env
npm run seed     # demo sports, events, users, bot liquidity
npm start        # http://127.0.0.1:7777
```

Demo accounts: `admin` / `admin123` (trading desk) and `demo` / `demo123`
(customer). Play money only.

## Architecture

_(finalized in the docs pass — see PLAN)_

## API

_(finalized in the docs pass)_

## Testing

```bash
npm test         # offline suite (temp DBs, ephemeral server, drift off)
npm run test:ui  # optional real-browser smoke (if Playwright is available)
```

## License

MIT — see [LICENSE](LICENSE).
