# Trade Syncer

A small website where you and a friend run a shared pool that automatically copies other traders:

| Venue | Who gets copied | How |
|---|---|---|
| **Polymarket** | The top traders on the leaderboard (auto-followed) plus any wallet you add | Every account's trades are public, so entries **and** exits are mirrored |
| **Kalshi** | "Whales" — unusually large orders on the public trade tape | Kalshi's top traders keep their trades private, so individual accounts can't be copied. Positions are held until the market settles (or a stop-loss) |
| **Solana memecoins** | Any wallet address you add (find good ones on GMGN, Birdeye, DexScreener top traders…) | Swaps are read from the chain; buys and sells are mirrored |

**It currently runs in paper-trading mode**: signals, prices and market settlements are real and live, but
the money is simulated. Nothing in this code can place a real order or move real funds yet. See
[Going live](#going-live).

## Running it

Needs Node.js 20 or newer. There are no dependencies to install.

```bash
npm start          # then open http://localhost:3000
npm test
```

The first two people to open the site create the two accounts; after that sign-up closes. Each of you
then uses **Add money** on the Overview tab.

Configuration is by environment variable — see `.env.example`. Set `INVITE_CODE` before putting it on a
public URL so a stranger can't claim the second seat.

## Putting it online so you can both reach it

It is one always-on Node process that keeps its data in a single file (`DATA_DIR/db.json`), so it needs a
host with a persistent disk. The repo is set up for [Railway](https://railway.com) (`railway.json`):

1. Sign up at railway.com with your GitHub account and pick the Hobby plan.
2. **New Project → Deploy from GitHub repo →** choose this repository. In the service's
   **Settings → Source**, set the branch to the one holding this code.
3. Right-click the service → **Attach volume**, mount path `/data`. Without this, accounts and
   balances are wiped on every redeploy.
4. **Variables** tab: add `INVITE_CODE` (any secret phrase) and, optionally, `SOLANA_RPC_URL`.
5. **Settings → Networking → Generate Domain.** Open that address, create your account, then send
   your friend the address and the invite code.

Any other host that runs a Docker container with a persistent disk mounted at `/data` works the same way
(Render, Fly.io, a VPS). Keep it to a single instance, and don't use a plan that sleeps when idle: trades
made while it sleeps are missed.

## How the shared pool works

The pool works like a small fund. Adding money buys you *units* at the pool's current value per unit, and
withdrawing sells them back. If the pool has grown 20% before your friend adds money, they buy in at the
higher price, so your earlier gains stay yours. The Members table shows each person's value, share and
profit. Withdrawals are limited to your own stake and to the pool's free cash.

## How a trade gets copied

When a followed trader buys, the pool buys the same thing if every check passes:

- **Size**: a percentage of the pool (default 2%) or a fixed amount, never more than the trader spent.
- **Limits**: max 10% of the pool in one position, 50% on one venue, 40 open positions, 60 new trades a day.
- **Price**: skipped if the price has already run past the trader's entry (5% on Polymarket, 20% on
  memecoins), or if it is above 95c / below 5c on prediction markets.
- **Quality filters**: trader orders under $100 are ignored; Kalshi markets closing within the hour and
  memecoins with under $20k liquidity are skipped.

When that trader sells, the pool sells the same fraction. Resolved markets are settled automatically.
Memecoins have a 40% stop-loss by default. Everything is adjustable in **Settings**, and every skipped
signal is listed with its reason under **Activity**. **Pause copying** stops new entries; exits still copy.

Paper fills use the live best ask/bid and include Kalshi's fee formula and an assumed 1% swap cost on Solana.
Real fills will be somewhat worse than paper fills, especially on thin memecoins.

## Going live

Real-money execution is deliberately not included yet. It needs things only you can provide and decide:

- **Kalshi**: an API key from your Kalshi account (US-regulated; the simplest to start with).
- **Polymarket**: a funded wallet's private key. Polymarket restricts access by country — check you are
  allowed to trade there.
- **Solana**: a dedicated hot wallet holding only what you are willing to lose.
- With real money the pool lives in exchange accounts/wallets owned by one of you; the app's ledger records
  who owns what, but it is a record between friends, not a legal structure.

Run in paper mode for a couple of weeks first. Copying top traders is not reliably profitable: you enter
after them at worse prices, leaderboards reward luck as well as skill, and memecoins can go to zero in
minutes. Only put in money you can afford to lose.

## Code layout

```
src/server.js           web server, login, JSON API
src/engine.js           copy logic: signal -> risk checks -> trade; pricing and settlement
src/fund.js             pool unit accounting
src/venues/*.js         Polymarket, Kalshi and Solana data connectors
src/store.js            JSON-file storage and default settings
public/                 the dashboard
test/                   unit tests
```
