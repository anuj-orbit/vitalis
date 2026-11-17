import express from "express";
import { fileURLToPath } from "node:url";
import { dbStatus, getPg } from "./db.js";
import { loadConfig } from "./config.js";
import { createMemoryStores, createPgStores } from "./stores/index.js";
import { createSimulatedPaymentProvider } from "./payments.js";
import { errorHandler, jsonOnly, notFoundApi, sessionMiddleware } from "./middleware.js";
import { authRouter } from "./routes/auth.js";
import { providersRouter } from "./routes/providers.js";
import { adminRouter } from "./routes/admin.js";
import { adminCreditsRouter, creditsRouter } from "./routes/credits.js";
import { adminBookingsRouter, bookingsRouter, slotsHandler } from "./routes/bookings.js";

export function createApp({
  config = loadConfig(),
  stores = getPg() ? createPgStores(getPg()) : createMemoryStores(),
  payments = createSimulatedPaymentProvider(),
  now = () => new Date(),
} = {}) {
  const deps = { stores, config, payments, now };
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.get("/health", async (_req, res) => {
    const db = await dbStatus();
    const healthy = !Object.values(db).includes("error");
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", ...db });
  });

  app.use("/api", jsonOnly, sessionMiddleware(deps));
  app.get("/api/providers/:id/slots", slotsHandler(deps));
  app.use("/api/auth", authRouter(deps));
  app.use("/api/providers", providersRouter(deps));
  app.use("/api/credits", creditsRouter(deps));
  app.use("/api/bookings", bookingsRouter(deps));
  app.use("/api/admin/credits", adminCreditsRouter(deps));
  app.use("/api/admin/bookings", adminBookingsRouter(deps));
  app.use("/api/admin", adminRouter(deps));
  app.use("/api", notFoundApi);
  app.use(errorHandler);
  return app;
}
