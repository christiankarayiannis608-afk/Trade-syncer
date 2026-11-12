// Tiny JSON-file database. Everything lives in memory and is flushed atomically to DATA_DIR/db.json.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  running: true,
  mode: 'paper',
  sizing: { mode: 'percent', percent: 2, fixedUsd: 25 },
  maxPositionPct: 10, // one position may never exceed this share of the pool
  maxVenuePct: 50, // one venue may never exceed this share of the pool
  maxOpenPositions: 40,
  maxTradesPerDay: 60,
  minLeaderUsd: 100, // ignore a trader's trades smaller than this
  polymarket: { enabled: true, autoFollowTop: 5, period: 'MONTH', maxSlippagePct: 5, minPrice: 0.05, maxPrice: 0.95, stopLossPct: 0 },
  kalshi: { enabled: true, whaleMinUsd: 10000, minHoursToClose: 1, minPrice: 0.1, maxPrice: 0.9, stopLossPct: 0, excludePrefixes: 'KXMVE' },
  solana: { enabled: true, maxSlippagePct: 20, minLiquidityUsd: 20000, costBps: 100, stopLossPct: 40 },
};

const fresh = () => ({
  users: [],
  sessions: {},
  fund: { cash: 0, totalUnits: 0, units: {}, ledger: [] },
  positions: {},
  trades: [],
  skipped: [],
  traders: [],
  nav: [],
  settings: structuredClone(DEFAULT_SETTINGS),
});

function mergeDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) target[k] = structuredClone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) mergeDefaults(target[k], v);
  }
  return target;
}

export function openStore(dir) {
  const file = dir && path.join(dir, 'db.json');
  let db = fresh();
  if (file && fs.existsSync(file)) db = mergeDefaults(JSON.parse(fs.readFileSync(file, 'utf8')), fresh());
  let timer = null;
  const flush = () => {
    timer = null;
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(db));
    fs.renameSync(file + '.tmp', file);
  };
  return {
    db,
    save() {
      if (!timer) timer = setTimeout(flush, 500);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}
