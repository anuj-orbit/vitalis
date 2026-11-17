import express from "express";
import { fileURLToPath } from "node:url";
import { dbStatus } from "./db.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.get("/health", async (_req, res) => {
    const db = await dbStatus();
    const healthy = !Object.values(db).includes("error");
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", ...db });
  });

  return app;
}
