import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createEngine } from '../src/engine.js';
import { deposit, withdraw, navOf, memberSummary } from '../src/fund.js';
import { parseSwap } from '../src/venues/solana.js';
import { fee as kalshiFee } from '../src/venues/kalshi.js';

function setup(quotes = {}) {
  const store = openStore(null);
  const { db } = store;
  db.users.push({ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' });
  const venue = { quote: async (id) => quotes[id] || {}, fee: () => 0 };
  const engine = createEngine(store, { polymarket: venue, kalshi: venue, solana: venue });
  const sig = (o) => ({ venue: 'polymarket', traderId: 't1', traderName: 'Top', side: 'BUY', assetId: 'X', title: 'Market X', leaderQty: 1000, leaderUsd: 500, leaderPrice: 0.5, ts: Date.now(), ...o });
  return { store, db, engine, sig, quotes };
}

test('later deposits buy in at the current pool value', () => {
  const { db } = setup();
  deposit(db, 'a', 100);
  db.positions.p = { qty: 100, lastPrice: 1, cost: 50 }; // pool doubled: 100 cash + 100 position
  deposit(db, 'b', 100);
  const [ann, bo] = memberSummary(db);
  assert.equal(Math.round(ann.value), 200);
  assert.equal(Math.round(bo.value), 100);
  assert.equal(Math.round(ann.pnl), 100);
  assert.equal(Math.round(bo.pnl), 0);
});

test('withdrawals are limited to your stake and to available cash', () => {
  const { db } = setup();
  deposit(db, 'a', 100);
  deposit(db, 'b', 50);
  assert.throws(() => withdraw(db, 'b', 60), /stake/);
  withdraw(db, 'b', 50);
  assert.equal(db.fund.cash, 100);
  db.fund.cash = 10;
  db.positions.p = { qty: 90, lastPrice: 1, cost: 90 };
  assert.throws(() => withdraw(db, 'a', 50), /cash/);
});

test('copies a buy at 2% of the pool, then mirrors a partial and a full exit', async () => {
  const { db, engine, sig, quotes } = setup({ X: { bid: 0.49, ask: 0.5 } });
  deposit(db, 'a', 1000);
  await engine.handle(sig());
  const pos = db.positions['polymarket:X'];
  assert.equal(pos.qty, 40); // $20 at 0.50
  assert.equal(db.fund.cash, 980);

  quotes.X = { bid: 0.6, ask: 0.61 };
  await engine.handle(sig({ side: 'SELL', leaderQty: 500 })); // trader sells half
  assert.equal(pos.qty, 20);
  await engine.handle(sig({ side: 'SELL', leaderQty: 500 }));
  assert.equal(db.positions['polymarket:X'], undefined);
  assert.equal(Math.round(db.fund.cash * 100), 100400); // 40 shares sold at 0.60 = $24 on $20
  assert.equal(db.trades.filter((t) => t.side === 'SELL').reduce((s, t) => s + t.pnl, 0).toFixed(2), '4.00');
});

test('skips buys that break the rules', async () => {
  const { db, engine, sig, quotes } = setup({ X: { bid: 0.49, ask: 0.5 }, HI: { bid: 0.97, ask: 0.98 }, RAN: { bid: 0.6, ask: 0.61 } });
  await engine.handle(sig());
  assert.match(db.skipped.at(-1).reason, /no money/);
  deposit(db, 'a', 1000);
  await engine.handle(sig({ assetId: 'HI' }));
  assert.match(db.skipped.at(-1).reason, /above maximum/);
  await engine.handle(sig({ assetId: 'RAN' })); // trader paid 0.50, now 0.61
  assert.match(db.skipped.at(-1).reason, /moved/);
  await engine.handle(sig({ ts: Date.now() - 3600e3 }));
  assert.match(db.skipped.at(-1).reason, /old/);
  await engine.handle(sig({ leaderUsd: 20 }));
  assert.match(db.skipped.at(-1).reason, /under/);
  db.settings.running = false;
  await engine.handle(sig());
  assert.match(db.skipped.at(-1).reason, /paused/);
  assert.equal(Object.keys(db.positions).length, 0);
  assert.equal(db.fund.cash, 1000);
  quotes.X = {};
});

test('position size is capped by the per-position limit and the trader\'s own size', async () => {
  const { db, engine, sig } = setup({ X: { bid: 0.5, ask: 0.5 } });
  deposit(db, 'a', 1000);
  db.settings.sizing.percent = 8;
  await engine.handle(sig());
  await engine.handle(sig()); // would be $160 total; capped at 10% = $100
  assert.equal(Math.round(db.positions['polymarket:X'].cost), 100);
  await engine.handle(sig({ assetId: 'Y', leaderUsd: 150, leaderPrice: 0 }));
  assert.equal(db.positions['polymarket:Y'], undefined); // no quote for Y
});

test('settles resolved markets and applies stop-losses when pricing', async () => {
  const { db, engine, sig, quotes } = setup({ X: { bid: 0.5, ask: 0.5 }, M: { bid: 1, ask: 1 } });
  deposit(db, 'a', 1000);
  await engine.handle(sig());
  await engine.handle(sig({ venue: 'solana', assetId: 'M', leaderPrice: 1 }));
  quotes.X = { settled: 1 };
  quotes.M = { bid: 0.5, ask: 0.5 }; // -50%, past the 40% stop
  await engine.mark();
  assert.deepEqual(db.positions, {});
  assert.equal(Math.round(navOf(db)), 1010); // +20 on X, -10 on M
  assert.deepEqual(db.trades.slice(-2).map((t) => t.reason).sort(), ['settled', 'stop-loss']);
});

test('parses a Solana swap from balance changes', () => {
  const W = 'Wallet1111111111111111111111111111111111111';
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: W }] } },
    meta: {
      err: null, fee: 5000, preBalances: [2e9], postBalances: [1e9 - 5000],
      preTokenBalances: [],
      postTokenBalances: [{ owner: W, mint: 'MEME', uiTokenAmount: { uiAmountString: '5000' } }],
    },
  };
  assert.deepEqual(parseSwap(tx, W, 100), { side: 'BUY', mint: 'MEME', qty: 5000, usd: 100 });
  assert.equal(parseSwap({ ...tx, meta: { ...tx.meta, postTokenBalances: [] } }, W, 100), null);
});

test('Kalshi fee rounds up to the cent', () => {
  assert.equal(kalshiFee(50, 0.5, 100), 1.75);
  assert.equal(kalshiFee(0.5, 0.5, 1), 0.02);
});
