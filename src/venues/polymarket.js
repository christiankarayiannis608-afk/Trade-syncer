// Polymarket: every account's trades are public, so we can follow specific top traders.
import { getJson, num } from '../util.js';

const DATA = 'https://data-api.polymarket.com/v2';
const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';

export const id = 'polymarket';

export async function leaderboard(period = 'MONTH', limit = 25) {
  const r = await getJson(`${DATA}/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=${limit}`);
  return (r.data || []).map((t) => ({
    rank: t.rank,
    address: t.user_id,
    name: !t.user_name || /^0x[0-9a-fA-F]{30,}/.test(t.user_name) ? `${t.user_id.slice(0, 6)}…${t.user_id.slice(-4)}` : t.user_name,
    pnl: num(t.pnl),
    volume: num(t.volume),
    url: `https://polymarket.com/profile/${t.user_id}`,
  }));
}

export function validAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

// New trades for one followed trader since their cursor, fills of the same outcome merged into one signal.
export async function pollTrader(trader) {
  const r = await getJson(`${DATA}/activity?user=${trader.address}&type=TRADE&limit=50`);
  const rows = (r.data || []).filter((a) => a.type === 'TRADE' && a.timestamp > (trader.cursor || 0));
  if (!rows.length) return [];
  trader.cursor = Math.max(...rows.map((a) => a.timestamp));
  const merged = new Map();
  for (const a of rows) {
    const key = `${a.token_id}:${a.side}`;
    const m = merged.get(key) || {
      venue: id,
      traderId: trader.id,
      traderName: trader.name,
      side: a.side,
      assetId: a.token_id,
      title: a.title,
      outcome: a.outcome,
      url: `https://polymarket.com/event/${a.event_slug || a.slug}`,
      leaderQty: 0,
      leaderUsd: 0,
      ts: 0,
    };
    m.leaderQty += num(a.size);
    m.leaderUsd += num(a.usdc_size, num(a.size) * num(a.price));
    m.ts = Math.max(m.ts, a.timestamp * 1000);
    merged.set(key, m);
  }
  return [...merged.values()].map((m) => ({ ...m, leaderPrice: m.leaderQty ? m.leaderUsd / m.leaderQty : 0 }));
}

async function sidePrice(tokenId, side) {
  const r = await getJson(`${CLOB}/price?token_id=${tokenId}&side=${side}`);
  return num(r.price);
}

// bid = what we'd get selling, ask = what we'd pay buying. `settled` is set once the market has resolved.
export async function quote(tokenId) {
  try {
    const [bid, ask] = await Promise.all([sidePrice(tokenId, 'BUY'), sidePrice(tokenId, 'SELL')]);
    if (bid || ask) return { bid, ask, mid: bid && ask ? (bid + ask) / 2 : bid || ask };
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  // No order book: the market is closed. Ask Gamma how it resolved.
  const r = await getJson(`${GAMMA}/markets?clob_token_ids=${tokenId}`);
  const m = Array.isArray(r) ? r[0] : null;
  if (m && m.closed) {
    const ids = JSON.parse(m.clobTokenIds || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');
    const i = ids.indexOf(tokenId);
    if (i >= 0 && prices[i] !== undefined) return { settled: num(prices[i]) };
  }
  return {};
}

export const fee = () => 0;
