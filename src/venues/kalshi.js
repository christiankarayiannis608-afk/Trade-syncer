// Kalshi: the leaderboard is public but top traders keep their individual trades hidden, so there is no
// per-person feed to copy. Instead we follow "whales": unusually large orders on Kalshi's public trade tape.
// If a followed nickname does make their trades public, we copy those directly too.
import { getJson, num, sleep } from '../util.js';

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const SOCIAL = 'https://api.elections.kalshi.com/v1/social';

export const id = 'kalshi';
export const WHALES_ID = 'kalshi:whales';

export async function leaderboard(limit = 25) {
  const r = await getJson(`${SOCIAL}/leaderboard?metric_name=projected_pnl&limit=${limit}&since_day_before=30`);
  return (r.rank_list || []).map((t) => ({
    rank: t.rank,
    address: t.nickname,
    name: t.nickname,
    pnl: num(t.value),
    url: `https://kalshi.com/ideas/profiles/${encodeURIComponent(t.nickname)}`,
  }));
}

const seen = new Set();
function firstSight(tradeId) {
  if (seen.has(tradeId)) return false;
  seen.add(tradeId);
  if (seen.size > 20000) for (const k of [...seen].slice(0, 10000)) seen.delete(k);
  return true;
}

const marketUrl = (ticker) => `https://kalshi.com/markets/${ticker.split('-')[0].toLowerCase()}`;

// Scan the public tape since the last poll and emit one signal per large taker order.
export async function pollWhales(state, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const since = state.cursor || now - 60;
  const excluded = String(cfg.excludePrefixes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const big = new Map();
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    let r;
    try {
      if (page) await sleep(700); // the tape is rate limited
      r = await getJson(`${API}/markets/trades?limit=1000&min_ts=${since}${cursor ? `&cursor=${cursor}` : ''}`);
    } catch (e) {
      if (!page) throw e;
      break; // keep what we already have
    }
    for (const t of r.trades || []) {
      if (!firstSight(t.trade_id)) continue;
      if (excluded.some((p) => t.ticker.startsWith(p))) continue;
      const side = t.taker_side;
      const price = num(side === 'yes' ? t.yes_price_dollars : t.no_price_dollars);
      const qty = num(t.count_fp);
      const key = `${t.ticker}:${side}`;
      const m = big.get(key) || { qty: 0, usd: 0, ts: 0, ticker: t.ticker, side };
      m.qty += qty;
      m.usd += qty * price;
      m.ts = Math.max(m.ts, Date.parse(t.created_time));
      big.set(key, m);
    }
    cursor = r.cursor;
    if (!cursor || (r.trades || []).length < 1000) break;
  }
  state.cursor = now - 2;
  return [...big.values()]
    .filter((m) => m.usd >= cfg.whaleMinUsd)
    .map((m) => ({
      venue: id,
      traderId: WHALES_ID,
      traderName: 'Kalshi whales',
      side: 'BUY',
      assetId: `${m.ticker}:${m.side}`,
      outcome: m.side.toUpperCase(),
      url: marketUrl(m.ticker),
      leaderQty: m.qty,
      leaderUsd: m.usd,
      leaderPrice: m.usd / m.qty,
      ts: m.ts,
    }));
}

// Works only for the rare profile that has made its trades public.
export async function pollTrader(trader) {
  const r = await getJson(`${SOCIAL}/trades?nickname=${encodeURIComponent(trader.address)}&limit=50`);
  trader.note = r.visibility_state === 'hidden' ? 'Trades hidden by this trader — nothing to copy' : '';
  const out = [];
  for (const t of r.trades || []) {
    const ts = Date.parse(t.created_time || t.create_date || 0);
    if (!ts || ts <= (trader.cursor || 0) || !t.ticker) continue;
    const side = t.taker_side || t.side;
    const price = num(side === 'yes' ? t.yes_price_dollars : t.no_price_dollars, num(t.price_dollars));
    const qty = num(t.count_fp, num(t.count));
    if (!side || !price || !qty) continue;
    out.push({
      venue: id,
      traderId: trader.id,
      traderName: trader.name,
      side: 'BUY',
      assetId: `${t.ticker}:${side}`,
      outcome: side.toUpperCase(),
      url: marketUrl(t.ticker),
      leaderQty: qty,
      leaderUsd: qty * price,
      leaderPrice: price,
      ts,
    });
  }
  if (out.length) trader.cursor = Math.max(...out.map((s) => s.ts));
  return out;
}

export async function quote(assetId) {
  const [ticker, side] = assetId.split(':');
  const { market: m } = await getJson(`${API}/markets/${ticker}`);
  const title = [m.title, m.yes_sub_title].filter(Boolean).join(' — ');
  if (m.result === 'yes' || m.result === 'no') return { settled: m.result === side ? 1 : 0, title };
  if (m.status !== 'active') return { title };
  const bid = num(m[`${side}_bid_dollars`]);
  const ask = num(m[`${side}_ask_dollars`]);
  return { bid, ask, mid: bid && ask ? (bid + ask) / 2 : bid || ask, title, closeTime: Date.parse(m.close_time) };
}

// Kalshi's standard taker fee: 7% of price x (1 - price) per contract, rounded up to the cent.
export const fee = (usd, price, qty) => Math.ceil(Number((7 * qty * price * (1 - price)).toFixed(6))) / 100;
