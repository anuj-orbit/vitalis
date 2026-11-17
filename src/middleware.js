import { SESSION_COOKIE, parseCookies, verifySession } from "./auth.js";

export class HttpError extends Error {
  constructor(status, code, message = code, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function sessionMiddleware({ stores, config, now }) {
  return asyncHandler(async (req, _res, next) => {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const session = verifySession(token, config.sessionSecret, now().getTime());
      if (session) req.user = await stores.users.findById(session.uid);
    }
    next();
  });
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, "UNAUTHENTICATED", "Login required"));
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, "UNAUTHENTICATED", "Login required"));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, "FORBIDDEN", "Not allowed"));
    next();
  };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function jsonOnly(req, _res, next) {
  if (WRITE_METHODS.has(req.method)) {
    const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"];
    if (hasBody && !req.is("application/json")) {
      return next(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
    }
  }
  next();
}

export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, _res, next) => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const k = key(req);
    let entry = hits.get(k);
    if (!entry) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) return next(new HttpError(429, "RATE_LIMITED", "Too many requests, try again later"));
    next();
  };
}

export function notFoundApi(_req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
}

export function errorHandler(err, _req, res, _next) {
  let status = 500;
  let body;
  if (err instanceof HttpError) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) };
  } else if (err instanceof SyntaxError && err.status === 400) {
    status = 400;
    body = { code: "VALIDATION", message: "Invalid JSON body" };
  } else if (err?.type === "entity.too.large") {
    status = 413;
    body = { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" };
  } else {
    console.error(err);
    body = { code: "INTERNAL", message: "Internal server error" };
  }
  res.status(status).json({ error: body });
}
