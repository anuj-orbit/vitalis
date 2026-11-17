import express from "express";
import { asyncHandler, requireAuth, requireRole, rateLimit, HttpError } from "../middleware.js";
import { packsFor, getBalance, topUp, adjustCredits, listLedger, parsePaging } from "../credits.js";

export function creditsRouter(deps) {
  const router = express.Router();

  router.get("/packs", (_req, res) => {
    res.json({
      creditPriceAed: deps.config.creditPriceAed,
      packs: packsFor(deps.config).map(({ credits, amountAed }) => ({ credits, amountAed })),
    });
  });

  router.get("/balance", requireAuth, asyncHandler(async (req, res) => {
    res.json({ balance: await getBalance(deps, req.user.id) });
  }));

  router.post(
    "/topup",
    requireAuth,
    rateLimit({ windowMs: 3600000, max: 30, key: (req) => `u${req.user.id}` }),
    asyncHandler(async (req, res) => {
      const { pack, idempotencyKey } = req.body ?? {};
      const result = await topUp(deps, { userId: req.user.id, pack, idempotencyKey });
      const { replayed, ...body } = result;
      res.status(replayed ? 200 : 201).json(replayed ? { ...body, replayed: true } : body);
    }),
  );

  router.get("/ledger", requireAuth, asyncHandler(async (req, res) => {
    const paging = parsePaging(req.query);
    res.json(await listLedger(deps, { userId: req.user.id, reason: req.query.reason, ...paging }));
  }));

  return router;
}

export function adminCreditsRouter(deps) {
  const router = express.Router();
  router.use(requireRole("admin"));

  router.get("/ledger", asyncHandler(async (req, res) => {
    const paging = parsePaging(req.query);
    let userId;
    if (req.query.userId !== undefined) {
      if (!/^\d+$/.test(String(req.query.userId))) throw new HttpError(400, "VALIDATION", "userId must be an integer", { field: "userId" });
      userId = Number(req.query.userId);
    }
    res.json(await listLedger(deps, { userId, reason: req.query.reason, ...paging }));
  }));

  router.post("/adjust", asyncHandler(async (req, res) => {
    const { userId, delta, note } = req.body ?? {};
    const result = await adjustCredits(deps, { adminId: req.user.id, userId, delta, note });
    res.status(201).json(result);
  }));

  return router;
}
