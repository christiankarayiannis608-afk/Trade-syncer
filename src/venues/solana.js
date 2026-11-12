// Solana memecoins: follow wallets on-chain. A swap shows up as the wallet's token balance changing in one
// direction while its SOL / stablecoin balance moves the other way.
import { getJson, num, sleep } from '../util.js';

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H8JoNMvZKSe9E9hHuegVY2mBwY', // USDT
]);

export const id = 'solana';

export function validAddress(a) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}

async function rpc(method, params) {
  const r = await getJson(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    timeout: 20000,
  });
  if (r.error) throw new Error(`Solana RPC: ${r.error.message}`);
  return r.result;
}

const priceCache = new Map();
async function jupPrice(mint) {
  const hit = priceCache.get(mint);
  if (hit && Date.now() - hit.at < 10000) return hit.v;
  const r = await getJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
  const v = r[mint] ? { price: num(r[mint].usdPrice), liquidity: num(r[mint].liquidity) } : null;
  priceCache.set(mint, { at: Date.now(), v });
  return v;
}

const symbols = new Map();
async function symbolOf(mint) {
  if (!symbols.has(mint)) {
    try {
      const r = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
      symbols.set(mint, r[0]?.baseToken?.symbol || mint.slice(0, 6));
    } catch {
      return mint.slice(0, 6);
    }
  }
  return symbols.get(mint);
}

// Turn one parsed transaction into a swap, or null if it isn't a simple buy/sell of one token.
export function parseSwap(tx, wallet, solPrice) {
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey || k);
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;
  const deltas = new Map();
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== wallet) continue;
      deltas.set(b.mint, (deltas.get(b.mint) || 0) + sign * num(b.uiTokenAmount.uiAmountString));
    }
  };
  add(tx.meta.postTokenBalances, 1);
  add(tx.meta.preTokenBalances, -1);
  // Value that moved in SOL or stablecoins (negative = the wallet paid).
  let usd = ((tx.meta.postBalances[idx] - tx.meta.preBalances[idx] + (idx === 0 ? tx.meta.fee : 0)) / 1e9) * solPrice;
  usd += (deltas.get(WSOL) || 0) * solPrice;
  for (const s of STABLES) usd += deltas.get(s) || 0;
  const tokens = [...deltas].filter(([mint, d]) => mint !== WSOL && !STABLES.has(mint) && Math.abs(d) > 0);
  if (tokens.length !== 1) return null;
  const [mint, d] = tokens[0];
  if (d > 0 && usd < 0) return { side: 'BUY', mint, qty: d, usd: -usd };
  if (d < 0 && usd > 0) return { side: 'SELL', mint, qty: -d, usd };
  return null;
}

export async function pollTrader(trader) {
  const sigs = await rpc('getSignaturesForAddress', [trader.address, { limit: 15, ...(trader.cursor ? { until: trader.cursor } : {}) }]);
  if (!sigs.length) return [];
  const first = !trader.cursor;
  trader.cursor = sigs[0].signature;
  if (first) return []; // start copying from now, not from history
  const sol = await jupPrice(WSOL);
  const out = [];
  for (const s of sigs.filter((x) => !x.err).reverse()) {
    await sleep(250); // stay under the public RPC rate limit
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const swap = parseSwap(tx, trader.address, sol?.price || 0);
    if (!swap) continue;
    const symbol = await symbolOf(swap.mint);
    out.push({
      venue: id,
      traderId: trader.id,
      traderName: trader.name,
      side: swap.side,
      assetId: swap.mint,
      title: symbol,
      outcome: '',
      url: `https://dexscreener.com/solana/${swap.mint}`,
      leaderQty: swap.qty,
      leaderUsd: swap.usd,
      leaderPrice: swap.usd / swap.qty,
      ts: (s.blockTime || 0) * 1000,
    });
  }
  return out;
}

export async function quote(mint) {
  const p = await jupPrice(mint);
  if (!p || !p.price) return {};
  return { bid: p.price, ask: p.price, mid: p.price, liquidity: p.liquidity };
}

// Swap fee + price impact, assumed as a flat percentage in paper mode.
export const fee = (usd, price, qty, cfg) => (usd * num(cfg.costBps)) / 10000;
