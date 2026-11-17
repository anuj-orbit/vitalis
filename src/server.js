import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { getPg } from "./db.js";
import { migrate } from "./schema.js";
import { ensureAdmin } from "./auth.js";
import { createMemoryStores, createPgStores } from "./stores/index.js";

const config = loadConfig();
const pool = getPg();
if (pool) await migrate(pool);
const stores = pool ? createPgStores(pool) : createMemoryStores();

if (pool) {
  const admin = await ensureAdmin({ stores, config });
  if (admin) console.log(`admin account ready: ${admin.email}`);
}

createApp({ config, stores }).listen(config.port, "0.0.0.0", () => {
  console.log(`listening on :${config.port}`);
});
