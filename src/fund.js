// Pool accounting. Members own "units" of the pool, like shares of a fund: a deposit buys units at the
// current value per unit, so someone who adds money after the pool has grown (or shrunk) gets a fair stake.

export function navOf(db) {
  let nav = db.fund.cash;
  for (const p of Object.values(db.positions)) nav += p.qty * p.lastPrice;
  return nav;
}

export function unitPrice(db) {
  return db.fund.totalUnits > 1e-9 ? navOf(db) / db.fund.totalUnits : 1;
}

function netDeposited(db, userId) {
  return db.fund.ledger
    .filter((l) => l.userId === userId)
    .reduce((s, l) => s + (l.type === 'deposit' ? l.amount : -l.amount), 0);
}

export function memberSummary(db) {
  const price = unitPrice(db);
  return db.users.map((u) => {
    const units = db.fund.units[u.id] || 0;
    const net = netDeposited(db, u.id);
    return {
      id: u.id,
      name: u.name,
      value: units * price,
      share: db.fund.totalUnits > 1e-9 ? units / db.fund.totalUnits : 0,
      netDeposited: net,
      pnl: units * price - net,
    };
  });
}

export function deposit(db, userId, amount) {
  if (!(amount > 0) || amount > 1e9) throw new Error('Enter an amount greater than zero');
  const price = unitPrice(db);
  const units = amount / price;
  db.fund.cash += amount;
  db.fund.totalUnits += units;
  db.fund.units[userId] = (db.fund.units[userId] || 0) + units;
  db.fund.ledger.push({ ts: Date.now(), userId, type: 'deposit', amount, units, unitPrice: price });
}

export function withdraw(db, userId, amount) {
  if (!(amount > 0)) throw new Error('Enter an amount greater than zero');
  const price = unitPrice(db);
  const myUnits = db.fund.units[userId] || 0;
  const mine = myUnits * price;
  if (amount > mine + 0.005) throw new Error(`Your stake is only $${mine.toFixed(2)}`);
  if (amount > db.fund.cash + 0.005)
    throw new Error(`Only $${db.fund.cash.toFixed(2)} is in cash; the rest is in open positions`);
  amount = Math.min(amount, mine, db.fund.cash);
  const units = Math.min(amount / price, myUnits);
  db.fund.cash -= amount;
  db.fund.totalUnits -= units;
  db.fund.units[userId] = myUnits - units;
  db.fund.ledger.push({ ts: Date.now(), userId, type: 'withdraw', amount, units, unitPrice: price });
}
