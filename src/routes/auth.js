import express from "express";
import {
  authenticate,
  clearSessionCookie,
  register,
  sessionCookie,
  signSession,
} from "../auth.js";
import { HttpError, asyncHandler, rateLimit } from "../middleware.js";

export function authRouter(deps) {
  const { stores, config, now } = deps;
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
  const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  const startSession = (res, user) => {
    const exp = Math.floor(now().getTime() / 1000) + config.sessionTtlSec;
    const token = signSession({ uid: user.id, exp }, config.sessionSecret);
    res.setHeader("Set-Cookie", sessionCookie(token, { secure: config.isProduction, maxAgeSec: config.sessionTtlSec }));
  };

  router.post(
    "/register",
    limiter,
    asyncHandler(async (req, res) => {
      const user = await register(deps, body(req));
      startSession(res, user);
      res.status(201).json({ user });
    }),
  );

  router.post(
    "/login",
    limiter,
    asyncHandler(async (req, res) => {
      const user = await authenticate(deps, body(req));
      if (!user) throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password");
      startSession(res, user);
      res.json({ user });
    }),
  );

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: config.isProduction }));
    res.status(204).end();
  });

  router.get(
    "/me",
    asyncHandler(async (req, res) => {
      let provider = null;
      if (req.user) {
        const row = await stores.providers.findByUserId(req.user.id);
        if (row) provider = { id: row.id, status: row.status, kind: row.kind };
      }
      res.json({ user: req.user, provider });
    }),
  );

  return router;
}
