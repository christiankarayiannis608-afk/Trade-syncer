export async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { accept: 'application/json', 'user-agent': 'trade-syncer/0.1', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  if (res.status === 429 && !opts.retried) {
    await sleep(1500); // rate limited: back off once
    return getJson(url, { ...opts, retried: true });
  }
  if (!res.ok) {
    const u = new URL(url);
    const err = new Error(`${res.status} from ${u.host}${u.pathname}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
