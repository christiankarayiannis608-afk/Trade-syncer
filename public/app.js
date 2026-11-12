const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => `<span class="${n > 0.005 ? 'up' : n < -0.005 ? 'down' : 'muted'}">${n > 0.005 ? '+' : ''}${usd(n)}</span>`;
const pct = (n) => (n * 100).toFixed(1) + '%';
const price = (p) => (p >= 1 ? p.toFixed(2) : p >= 0.01 ? p.toFixed(3) : p.toPrecision(3));
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const VENUE = { polymarket: 'Polymarket', kalshi: 'Kalshi', solana: 'Solana' };
const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : '#');
const market = (r) => `<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>${r.outcome ? ` <span class="tag">${esc(r.outcome)}</span>` : ''}`;

let state = null;
let registering = false;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') showAuth();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function table(el, heads, rows, empty) {
  if (!rows.length) return (el.innerHTML = `<tr><td class="empty">${empty}</td></tr>`);
  el.innerHTML =
    `<tr>${heads.map((h) => `<th${h.startsWith('#') ? ' class="n"' : ''}>${h.replace('#', '')}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${r.map((c, i) => `<td class="${heads[i].startsWith('#') ? 'n' : i === 0 ? 't' : ''}">${c}</td>`).join('')}</tr>`).join('');
}

// ---------- auth ----------
async function showAuth() {
  const s = await api('/api/session');
  if (s.user) return boot();
  $('#app').hidden = true;
  $('#auth').hidden = false;
  registering = s.canRegister && (registering || s.empty);
  const set = () => {
    $('#authSubmit').textContent = registering ? 'Create account' : 'Sign in';
    $('#authLead').textContent = registering ? 'Create your login for the shared pool.' : 'Sign in to your shared pool.';
    $('#authSwitch').textContent = registering ? 'I already have an account' : 'Create an account';
    $('#authSwitch').hidden = !s.canRegister;
    $('#inviteRow').hidden = !(registering && s.inviteRequired);
  };
  $('#authSwitch').onclick = () => { registering = !registering; set(); };
  set();
}

$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(registering ? '/api/register' : '/api/login', Object.fromEntries(f));
    $('#authError').textContent = '';
    e.target.reset();
    boot();
  } catch (err) {
    $('#authError').textContent = err.message;
  }
};
$('#logout').onclick = async () => { await api('/api/logout', {}); state = null; showAuth(); };

// ---------- rendering ----------
function render() {
  const s = state, f = s.fund;
  $('#whoName').textContent = s.me.name;
  $('#pauseBtn').textContent = s.settings.running ? 'Pause copying' : 'Resume copying';
  const banner = $('#banner');
  banner.hidden = s.settings.running && f.nav > 0;
  banner.textContent = !s.settings.running ? 'Copying is paused. Open positions are still tracked and exits are still copied.' : 'The pool is empty — add money on the Overview tab to start copying trades.';

  const me = s.members.find((m) => m.id === s.me.id) || { value: 0, share: 0, pnl: 0 };
  $('#tiles').innerHTML = [
    ['Pool value', usd(f.nav), `${usd(f.cash)} in cash`],
    ['Profit / loss', signed(f.pnl), f.deposited > 0 ? `${(f.pnl / f.deposited * 100).toFixed(1)}% on ${usd(f.deposited)} added` : 'Nothing added yet'],
    ['Your share', usd(me.value), `${pct(me.share)} of the pool`],
    ['Open positions', s.positions.length, `${usd(f.invested)} invested`],
  ].map(([k, v, sub]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

  table($('#members'), ['Member', '#Value', '#Share', '#Added', '#P/L'],
    s.members.map((m) => [esc(m.name) + (m.id === s.me.id ? ' <span class="tag">you</span>' : ''), usd(m.value), pct(m.share), usd(m.netDeposited), signed(m.pnl)]), 'No members yet');

  const tradeRow = (t) => [market(t), `<span class="tag">${VENUE[t.venue]}</span>`, t.side === 'BUY' ? 'Buy' : 'Sell', usd(t.usd), price(t.price), t.pnl === undefined ? '' : signed(t.pnl), esc(t.traderName || ''), esc(t.reason), when(t.ts)];
  const tradeHeads = ['Market', 'Venue', 'Side', '#Amount', '#Price', '#P/L', 'Copied from', 'Why', 'When'];
  table($('#recent'), tradeHeads, s.trades.slice(0, 8).map(tradeRow), 'No trades yet. Once the pool has money, trades appear here as the traders you follow make them.');
  table($('#tradeTable'), tradeHeads, s.trades.map(tradeRow), 'No trades yet');

  table($('#posTable'), ['Market', 'Venue', '#Cost', '#Avg price', '#Now', '#Value', '#P/L', 'Copied from', ''],
    s.positions.sort((a, b) => b.value - a.value).map((p) => [market(p), `<span class="tag">${VENUE[p.venue]}</span>`, usd(p.cost), price(p.avgPrice), price(p.lastPrice), usd(p.value), signed(p.pnl), esc(p.trader || ''),
      `<button class="mini ghost" data-close="${esc(p.key)}">Close</button>`]), 'No open positions');

  table($('#skipTable'), ['Market', 'Venue', 'Trader', 'Reason', 'When'],
    s.skipped.map((k) => [esc(k.title) + (k.outcome ? ` <span class="tag">${esc(k.outcome)}</span>` : ''), `<span class="tag">${VENUE[k.venue]}</span>`, esc(k.traderName), esc(k.reason), when(k.ts)]), 'Nothing skipped yet');

  table($('#ledgerTable'), ['Member', 'Type', '#Amount', '#Pool unit price', 'When'],
    s.ledger.map((l) => [esc(l.name), l.type === 'deposit' ? 'Added' : 'Withdrew', usd(l.amount), '$' + l.unitPrice.toFixed(4), when(l.ts)]), 'No deposits yet');

  table($('#traderTable'), ['Trader', 'Venue', '#Trades copied', '#Realized P/L', 'Status', ''],
    s.traders.map((t) => [
      esc(t.name) + (t.auto ? ' <span class="tag">auto: leaderboard</span>' : '') + (t.note ? `<div class="small down">${esc(t.note)}</div>` : ''),
      `<span class="tag">${VENUE[t.venue]}</span>`, t.copies, signed(t.pnl), t.enabled ? 'Copying' : 'Paused',
      t.builtin ? '<span class="muted small">Change in Settings</span>' : `<button class="mini ghost" data-toggle="${esc(t.id)}">${t.enabled ? 'Pause' : 'Resume'}</button> <button class="mini ghost" data-remove="${esc(t.id)}">Remove</button>`,
    ]), 'Not following anyone yet');

  const names = { polymarket: 'Polymarket', kalshi: 'Kalshi', solana: 'Solana', prices: 'Prices' };
  $('#health').innerHTML = 'Data feeds: ' + Object.entries(names).map(([k, n]) => {
    const st = s.status[k];
    return `${n} ${!st ? '…' : st.error ? `<span class="down" title="${esc(st.error)}">⚠ error</span>` : '✓'}`;
  }).join(' · ');

  drawChart(s.nav);
  if (!$('#settingsForm').dataset.ready) renderSettings();
}

function drawChart(points) {
  const el = $('#chart');
  if (points.length < 2) return (el.innerHTML = '<p class="empty">The chart fills in once the pool has been running for a few minutes.</p>');
  const xs = points.map((p) => p.ts), ys = points.map((p) => p.nav);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo || hi * 0.02 || 1) * 0.12;
  lo -= pad; hi += pad;
  const x = (t) => ((t - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * 100;
  const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(2)},${y(p.nav).toFixed(2)}`).join('');
  const ticks = [0.15, 0.5, 0.85].map((f) => lo + (hi - lo) * f);
  el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Pool value over time">
      ${ticks.map((t) => `<line class="grid" x1="0" x2="100" y1="${y(t)}" y2="${y(t)}"/>`).join('')}
      <path class="line" d="${d}"/><line class="cross" id="cross" y1="0" y2="100" visibility="hidden"/></svg>
    ${ticks.map((t) => `<span class="axis" style="top:${y(t)}%">${usd(t)}</span>`).join('')}
    <span class="dot" hidden></span><span class="tip" hidden></span>`;
  const cross = el.querySelector('#cross'), dot = el.querySelector('.dot'), tip = el.querySelector('.tip');
  el.onpointermove = (e) => {
    const r = el.getBoundingClientRect();
    const t = xs[0] + ((e.clientX - r.left) / r.width) * (xs[xs.length - 1] - xs[0]);
    const p = points.reduce((a, b) => (Math.abs(b.ts - t) < Math.abs(a.ts - t) ? b : a));
    cross.setAttribute('x1', x(p.ts)); cross.setAttribute('x2', x(p.ts)); cross.setAttribute('visibility', 'visible');
    dot.hidden = tip.hidden = false;
    dot.style.left = x(p.ts) + '%'; dot.style.top = y(p.nav) + '%';
    tip.style.left = Math.min(88, Math.max(12, x(p.ts))) + '%';
    tip.textContent = `${usd(p.nav)} · ${when(p.ts)}`;
  };
  el.onpointerleave = () => { cross.setAttribute('visibility', 'hidden'); dot.hidden = tip.hidden = true; };
}

// ---------- settings ----------
const FIELDS = [
  ['How much to put in each copied trade', [
    ['sizing.mode', 'Sizing', { percent: 'Percent of pool', fixed: 'Fixed dollar amount' }],
    ['sizing.percent', 'Percent of pool per trade (%)'],
    ['sizing.fixedUsd', 'Fixed amount per trade ($)'],
  ]],
  ['Safety limits', [
    ['maxPositionPct', 'Max in one position (% of pool)'],
    ['maxVenuePct', 'Max on one venue (% of pool)'],
    ['maxOpenPositions', 'Max open positions'],
    ['maxTradesPerDay', 'Max new trades per day'],
    ['minLeaderUsd', "Ignore trader's orders under ($)"],
  ]],
  ['Polymarket', [
    ['polymarket.enabled', 'Copy Polymarket traders'],
    ['polymarket.autoFollowTop', 'Auto-follow top N of leaderboard (0 = off)'],
    ['polymarket.period', 'Leaderboard period', { DAY: 'Today', WEEK: 'This week', MONTH: 'This month', ALL: 'All time' }],
    ['polymarket.maxSlippagePct', "Skip if price moved past trader's entry by (%)"],
    ['polymarket.minPrice', 'Min price to buy (0–1)'],
    ['polymarket.maxPrice', 'Max price to buy (0–1)'],
    ['polymarket.stopLossPct', 'Stop-loss (% drop, 0 = off)'],
  ]],
  ['Kalshi (whale feed)', [
    ['kalshi.enabled', 'Copy large Kalshi orders'],
    ['kalshi.whaleMinUsd', 'Order counts as a whale above ($)'],
    ['kalshi.minHoursToClose', 'Skip markets closing within (hours)'],
    ['kalshi.minPrice', 'Min price to buy (0–1)'],
    ['kalshi.maxPrice', 'Max price to buy (0–1)'],
    ['kalshi.stopLossPct', 'Stop-loss (% drop, 0 = off)'],
    ['kalshi.excludePrefixes', 'Ignore tickers starting with (comma-separated)'],
  ]],
  ['Solana memecoins', [
    ['solana.enabled', 'Copy Solana wallets'],
    ['solana.maxSlippagePct', "Skip if price moved past trader's entry by (%)"],
    ['solana.minLiquidityUsd', 'Min token liquidity ($)'],
    ['solana.costBps', 'Assumed swap cost (hundredths of a %)'],
    ['solana.stopLossPct', 'Stop-loss (% drop, 0 = off)'],
  ]],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

function renderSettings() {
  const form = $('#settingsForm');
  form.dataset.ready = '1';
  form.innerHTML = FIELDS.map(([legend, fields]) => `<fieldset><legend>${legend}</legend>${fields.map(([p, label, opts]) => {
    const v = getPath(state.settings, p);
    if (typeof v === 'boolean') return `<label class="check"><input type="checkbox" name="${p}" ${v ? 'checked' : ''}>${label}</label>`;
    if (opts) return `<label>${label}<select name="${p}">${Object.entries(opts).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
    return `<label>${label}<input name="${p}" value="${esc(v)}" ${typeof v === 'number' ? 'type="number" step="any" min="0"' : ''}></label>`;
  }).join('')}</fieldset>`).join('') + '<div class="row"><button class="primary">Save settings</button><span class="muted small" id="settingsMsg" role="status"></span></div>';
}

$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    const keys = el.name.split('.');
    let o = patch;
    for (const k of keys.slice(0, -1)) o = o[k] ||= {};
    o[keys.at(-1)] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  try {
    await api('/api/settings', patch);
    $('#settingsMsg').textContent = 'Saved';
    setTimeout(() => ($('#settingsMsg').textContent = ''), 2500);
    delete e.target.dataset.ready;
    refresh();
  } catch (err) {
    $('#settingsMsg').textContent = err.message;
  }
};

// ---------- actions ----------
$('#tabs').onclick = (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  for (const b of $('#tabs').children) b.classList.toggle('active', b === e.target);
  for (const sec of document.querySelectorAll('main > section')) sec.hidden = sec.id !== tab;
  if (tab === 'traders') loadLeaderboards();
};

$('#pauseBtn').onclick = async () => { await api('/api/settings', { running: !state.settings.running }); refresh(); };

$('#moneyForm').onsubmit = async (e) => {
  e.preventDefault();
  const kind = e.submitter?.value || 'deposit';
  try {
    await api('/api/' + kind, { amount: Number(new FormData(e.target).get('amount')) });
    $('#moneyError').textContent = '';
    e.target.reset();
    refresh();
  } catch (err) {
    $('#moneyError').textContent = err.message;
  }
};

$('#traderForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/traders', Object.fromEntries(new FormData(e.target)));
    $('#traderError').textContent = '';
    e.target.reset();
    refresh();
  } catch (err) {
    $('#traderError').textContent = err.message;
  }
};

document.addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.toggle) await api('/api/traders/toggle', { id: d.toggle });
    else if (d.remove) { if (!confirm('Stop following this trader?')) return; await api('/api/traders/remove', { id: d.remove }); }
    else if (d.close) { if (!confirm('Close this position at the current price?')) return; await api('/api/positions/close', { key: d.close }); }
    else if (d.follow) await api('/api/traders', { venue: 'polymarket', address: d.follow, name: d.name });
    else return;
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

async function loadLeaderboards() {
  const followed = new Set(state.traders.map((t) => (t.address || '').toLowerCase()));
  for (const [venue, el] of [['polymarket', $('#lbPoly')], ['kalshi', $('#lbKalshi')]]) {
    try {
      const { rows } = await api('/api/leaderboard?venue=' + venue);
      table(el, ['#Rank', 'Trader', venue === 'kalshi' ? '#30-day profit' : '#Profit', ''], rows.map((r) => [
        r.rank, `<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.name)}</a>`, usd(r.pnl),
        venue === 'kalshi' ? '' : followed.has(r.address.toLowerCase()) ? '<span class="muted small">Following</span>' : `<button class="mini ghost" data-follow="${esc(r.address)}" data-name="${esc(r.name)}">Follow</button>`,
      ]), 'No data');
    } catch (err) {
      el.innerHTML = `<tr><td class="empty">Couldn't load: ${esc(err.message)}</td></tr>`;
    }
  }
}

async function refresh() {
  try {
    state = await api('/api/state');
    render();
  } catch {}
}

async function boot() {
  const s = await api('/api/session');
  if (!s.user) return showAuth();
  $('#auth').hidden = true;
  $('#app').hidden = false;
  await refresh();
}

setInterval(() => state && !document.hidden && refresh(), 10000);
boot();
