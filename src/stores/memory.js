export function createMemoryState() {
  return {
    seq: { users: 0, providers: 0, availability: 0, bookings: 0, ledger: 0 },
    users: [],
    providers: [],
    availability: [],
    bookings: [],
    ledger: [],
  };
}

export function nextId(state, table) {
  state.seq[table] += 1;
  return state.seq[table];
}

export function pageOf(rows, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  return { items: rows.slice(off, off + lim), total: rows.length };
}

export function pageParams({ limit, offset }) {
  return {
    limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
    offset: Math.max(Number(offset) || 0, 0),
  };
}
