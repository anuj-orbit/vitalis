import { withPgTx } from "../db.js";
import { createMemoryState } from "./memory.js";
import { pgUsersRepo, memUsersRepo } from "./users.js";
import { pgProvidersRepo, memProvidersRepo } from "./providers.js";
import { pgAvailabilityRepo, memAvailabilityRepo } from "./availability.js";
import { pgBookingsRepo, memBookingsRepo } from "./bookings.js";
import { pgLedgerRepo, memLedgerRepo } from "./ledger.js";

function bindPg(q) {
  return {
    users: pgUsersRepo(q),
    providers: pgProvidersRepo(q),
    availability: pgAvailabilityRepo(q),
    bookings: pgBookingsRepo(q),
    ledger: pgLedgerRepo(q),
  };
}

function bindMemory(state) {
  return {
    users: memUsersRepo(state),
    providers: memProvidersRepo(state),
    availability: memAvailabilityRepo(state),
    bookings: memBookingsRepo(state),
    ledger: memLedgerRepo(state),
  };
}

export function createPgStores(pool) {
  return {
    ...bindPg(pool),
    tx: (fn) =>
      withPgTx(pool, (client) => {
        const txStores = bindPg(client);
        txStores.tx = (inner) => inner(txStores);
        return fn(txStores);
      }),
  };
}

export function createMemoryStores() {
  const state = createMemoryState();
  const root = bindMemory(state);
  let chain = Promise.resolve();
  root.tx = (fn) => {
    const run = chain.then(async () => {
      const snapshot = structuredClone(state);
      const txStores = bindMemory(state);
      txStores.tx = (inner) => inner(txStores);
      try {
        return await fn(txStores);
      } catch (err) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, snapshot);
        throw err;
      }
    });
    chain = run.catch(() => {});
    return run;
  };
  return root;
}
