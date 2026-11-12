// The copy engine: turns traders' trades ("signals") into sized, risk-checked trades for the pool,
// keeps positions priced, and settles them when markets resolve.
import crypto from 'node:crypto';
import * as polymarket from './venues/polymarket.js';
import * as kalshi from './venues/kalshi.js';
import * as solana from './venues/solana.js';
import { navOf, unitPrice } from './fund.js';

export const VENUES = { polymarket, kalshi, solana };
const STALE_MS = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export function createEngine(store, venues = VENUES) {
  const { db } = store;
  const status = {};
  const kalshiState = {};

  const cap = (list, n) => list.length > n && list.splice(0, list.length - n);

  function skip(sig, reason) {
    db.skipped.push({ ts: Date.now(), venue: sig.venue, side: sig.side, title: sig.title || sig.assetId, outcome: sig.outcome, traderName: sig.traderName, reason });
    cap(db.skipped, 200);
  }

  function record(pos, side, qty, price, usd, fee, sig, reason, pnl) {
    db.trades.push({
      ts: Date.now(), venue: pos.venue, side, title: pos.title, outcome: pos.outcome, url: pos.url,
      qty, price, usd, fee, traderId: sig?.traderId || pos.openedBy, traderName: sig?.traderName || pos.openedByName, reason, pnl,
    });
    cap(db.trades, 3000);
  }

  // Sell `frac` of a position at `price`; removes it when fully closed.
  function reduce(pos, frac, price, reason, sig) {
    frac = Math.min(1, Math.max(0, frac));
    const qty = pos.qty * frac;
    if (!(qty > 0)) return;
    const gross = qty * price;
    const fee = reason === 'settled' ? 0 : venues[pos.venue].fee(gross, price, qty, db.settings[pos.venue]);
    const costPart = pos.cost * frac;
    db.fund.cash += gross - fee;
    pos.qty -= qty;
    pos.cost -= costPart;
    pos.lastPrice = price;
    record(pos, 'SELL', qty, price, gross, fee, sig, reason, gross - fee - costPart);
    if (frac >= 1 || pos.qty * price < 0.01) delete db.positions[pos.key];
  }

  function tradesToday() {
    const since = Date.now() - DAY;
    return db.trades.filter((t) => t.ts > since && t.side === 'BUY').length;
  }

  async function handle(sig) {
    const s = db.settings;
    const cfg = s[sig.venue];
    const key = `${sig.venue}:${sig.assetId}`;
    const pos = db.positions[key];
    const trader = db.traders.find((t) => t.id === sig.traderId);

    if (sig.side === 'SELL') {
      const held = pos?.leaders[sig.traderId];
      if (!pos || !(held > 0)) return; // we never copied this trader into it
      const q = await venues[sig.venue].quote(sig.assetId, cfg);
      if (!(q.bid > 0)) return skip(sig, 'No buyer to sell to right now');
      const frac = Math.min(1, sig.leaderQty / held);
      pos.leaders[sig.traderId] = held - sig.leaderQty;
      reduce(pos, frac, q.bid, 'copied exit', sig);
      return;
    }

    // BUY
    const trackLeader = () => {
      const p = db.positions[key];
      if (p) p.leaders[sig.traderId] = (p.leaders[sig.traderId] || 0) + sig.leaderQty;
    };
    const no = (reason) => (trackLeader(), skip(sig, reason));

    if (!s.running) return no('Copying is paused');
    if (!cfg.enabled) return no(`${sig.venue} is switched off`);
    if (trader && !trader.enabled) return no('Trader is paused');
    if (Date.now() - sig.ts > STALE_MS) return no('Signal was too old');
    if (sig.leaderUsd < s.minLeaderUsd) return no(`Trader's order under $${s.minLeaderUsd}`);
    if (tradesToday() >= s.maxTradesPerDay) return no('Daily trade limit reached');
    if (!pos && Object.keys(db.positions).length >= s.maxOpenPositions) return no('Max open positions reached');

    const nav = navOf(db);
    if (!(nav > 0)) return no('Pool has no money yet');

    const q = await venues[sig.venue].quote(sig.assetId, cfg);
    if (q.title && !sig.title) sig.title = q.title;
    if (q.settled !== undefined || !(q.ask > 0)) return no('Market closed or no price');
    if (cfg.minPrice && q.ask < cfg.minPrice) return no(`Price ${q.ask.toFixed(3)} below minimum`);
    if (cfg.maxPrice && q.ask > cfg.maxPrice) return no(`Price ${q.ask.toFixed(3)} above maximum — little upside left`);
    if (cfg.minHoursToClose && q.closeTime && q.closeTime - Date.now() < cfg.minHoursToClose * 3600e3) return no('Market closes too soon');
    if (cfg.minLiquidityUsd && q.liquidity !== undefined && q.liquidity < cfg.minLiquidityUsd) return no('Token liquidity too thin');
    if (cfg.maxSlippagePct && sig.leaderPrice > 0 && q.ask > sig.leaderPrice * (1 + cfg.maxSlippagePct / 100))
      return no(`Price moved ${((q.ask / sig.leaderPrice - 1) * 100).toFixed(0)}% past the trader's entry`);

    const venueValue = Object.values(db.positions).filter((p) => p.venue === sig.venue).reduce((a, p) => a + p.qty * p.lastPrice, 0);
    const want = s.sizing.mode === 'fixed' ? s.sizing.fixedUsd : (nav * s.sizing.percent) / 100;
    const usd = Math.min(
      want,
      sig.leaderUsd, // never bet more than the trader did
      (nav * s.maxPositionPct) / 100 - (pos ? pos.qty * pos.lastPrice : 0),
      (nav * s.maxVenuePct) / 100 - venueValue,
      db.fund.cash * 0.995,
    );
    if (!(usd >= 1)) return no(usd < want && db.fund.cash < want ? 'Not enough cash' : 'Position or venue limit reached');

    const qty = usd / q.ask;
    const fee = venues[sig.venue].fee(usd, q.ask, qty, cfg);
    db.fund.cash -= usd + fee;
    const p = (db.positions[key] ||= {
      key, venue: sig.venue, assetId: sig.assetId, title: sig.title || sig.assetId, outcome: sig.outcome || '', url: sig.url,
      qty: 0, cost: 0, lastPrice: q.ask, leaders: {}, openedAt: Date.now(), openedBy: sig.traderId, openedByName: sig.traderName,
    });
    p.qty += qty;
    p.cost += usd + fee;
    p.lastPrice = q.bid > 0 ? q.bid : q.ask;
    trackLeader();
    record(p, 'BUY', qty, q.ask, usd, fee, sig, 'copied entry');
  }

  async function process(signals) {
    for (const sig of signals.sort((a, b) => a.ts - b.ts)) {
      try {
        await handle(sig);
      } catch (e) {
        skip(sig, `Error: ${e.message}`);
      }
    }
    if (signals.length) store.save();
  }

  // Disabled traders are still watched while we hold something of theirs, so their exits get copied.
  const watching = (t) => t.enabled || Object.values(db.positions).some((p) => p.leaders[t.id] > 0);

  async function pollTraders(venue) {
    if (!db.settings[venue].enabled && !Object.values(db.positions).some((p) => p.venue === venue)) return;
    const errors = [];
    for (const t of db.traders.filter((t) => t.venue === venue && watching(t))) {
      try {
        await process(await venues[venue].pollTrader(t));
        t.error = '';
      } catch (e) {
        t.error = e.message;
        errors.push(`${t.name}: ${e.message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  async function pollKalshiTape() {
    const cfg = db.settings.kalshi;
    if (!cfg.enabled || !db.settings.running) return (kalshiState.cursor = 0);
    await process(await venues.kalshi.pollWhales(kalshiState, cfg));
  }

  async function syncLeaderboard() {
    const cfg = db.settings.polymarket;
    if (!cfg.enabled || !(cfg.autoFollowTop > 0)) return;
    const top = (await venues.polymarket.leaderboard(cfg.period, cfg.autoFollowTop)).slice(0, cfg.autoFollowTop);
    const addrs = new Set(top.map((t) => t.address.toLowerCase()));
    for (const t of db.traders) if (t.auto && t.venue === 'polymarket') t.enabled = addrs.has(t.address.toLowerCase());
    for (const t of top) addTrader({ venue: 'polymarket', address: t.address, name: t.name, auto: true });
    store.save();
  }

  function addTrader({ venue, address, name, auto = false, addedBy = null }) {
    address = String(address || '').trim();
    if (!venues[venue]) throw new Error('Unknown venue');
    if (venues[venue].validAddress && !venues[venue].validAddress(address)) throw new Error(`That doesn't look like a ${venue} wallet address`);
    if (!address) throw new Error('Address required');
    if (/^0x[0-9a-fA-F]{30,}/.test(name || '')) name = ''; // leaderboard "names" that are just the wallet
    const existing = db.traders.find((t) => t.venue === venue && t.address.toLowerCase() === address.toLowerCase());
    if (existing) {
      if (!auto) existing.auto = false; // a manual follow sticks even if they drop off the leaderboard
      return existing;
    }
    const t = {
      id: crypto.randomBytes(6).toString('hex'), venue, address, name: String(name || '').trim().slice(0, 40) || `${address.slice(0, 6)}…${address.slice(-4)}`,
      enabled: true, auto, addedBy, addedAt: Date.now(),
      cursor: venue === 'polymarket' ? Math.floor(Date.now() / 1000) : venue === 'kalshi' ? Date.now() : null,
    };
    db.traders.push(t);
    return t;
  }

  async function mark() {
    for (const pos of Object.values(db.positions)) {
      try {
        const cfg = db.settings[pos.venue];
        const q = await venues[pos.venue].quote(pos.assetId, cfg);
        if (q.settled !== undefined) reduce(pos, 1, q.settled, 'settled');
        else if (q.bid > 0 || q.mid > 0) {
          pos.lastPrice = q.bid > 0 ? q.bid : q.mid;
          const avg = pos.cost / pos.qty;
          if (cfg.stopLossPct > 0 && q.bid > 0 && q.bid <= avg * (1 - cfg.stopLossPct / 100)) reduce(pos, 1, q.bid, 'stop-loss');
        }
      } catch (e) {
        pos.error = e.message;
      }
    }
    snapshot();
    store.save();
  }

  function snapshot() {
    if (!(db.fund.totalUnits > 0)) return;
    const last = db.nav[db.nav.length - 1];
    if (last && Date.now() - last.ts < 5 * 60 * 1000) return;
    db.nav.push({ ts: Date.now(), nav: navOf(db), unit: unitPrice(db) });
    cap(db.nav, 5000);
  }

  const jobs = [
    { name: 'polymarket', every: 30e3, run: () => pollTraders('polymarket') },
    { name: 'kalshi', every: 20e3, run: async () => { await pollKalshiTape(); await pollTraders('kalshi'); } },
    { name: 'solana', every: 45e3, run: () => pollTraders('solana') },
    { name: 'prices', every: 60e3, run: mark },
    { name: 'leaderboard', every: 6 * 3600e3, run: syncLeaderboard },
  ];

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    for (const j of jobs) {
      const st = (status[j.name] ||= {});
      if (Date.now() - (st.lastRun || 0) < j.every) continue;
      st.lastRun = Date.now();
      try {
        await j.run();
        st.error = '';
        st.lastOk = Date.now();
      } catch (e) {
        st.error = e.message;
      }
    }
    busy = false;
  }

  return {
    status, handle, process, mark, addTrader, syncLeaderboard, tick,
    closePosition(key) {
      const pos = db.positions[key];
      if (!pos) throw new Error('Position not found');
      return venues[pos.venue].quote(pos.assetId, db.settings[pos.venue]).then((q) => {
        if (q.settled !== undefined) reduce(pos, 1, q.settled, 'settled');
        else if (q.bid > 0) reduce(pos, 1, q.bid, 'closed manually');
        else throw new Error('No buyer available right now');
        store.save();
      });
    },
    start() {
      tick();
      return setInterval(tick, 5000);
    },
  };
}
