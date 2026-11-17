import express from "express";
import { HttpError, asyncHandler, requireRole } from "../middleware.js";
import { parseId, parsePaging } from "./providers.js";

const STATUSES = ["pending", "approved", "rejected"];
const ROLES = ["consumer", "provider", "admin"];

const bad = (field, message) => new HttpError(400, "VALIDATION", message, { field });

function parseNote(input) {
  const note = input?.note;
  if (note === undefined || note === null || note === "") return null;
  if (typeof note !== "string" || note.length > 500) throw bad("note", "note must be a string of at most 500 chars");
  return note.trim() || null;
}

export function adminRouter({ stores }) {
  const router = express.Router();
  router.use(requireRole("admin"));

  router.get(
    "/applications",
    asyncHandler(async (req, res) => {
      const status = req.query.status ?? "pending";
      if (status !== "all" && !STATUSES.includes(status)) throw bad("status", "status must be pending, approved, rejected or all");
      res.json(
        await stores.providers.list({ status: status === "all" ? undefined : status, ...parsePaging(req.query) }),
      );
    }),
  );

  const review = (target) =>
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const note = parseNote(req.body);
      const provider = await stores.tx(async (tx) => {
        const current = await tx.providers.findById(id);
        if (!current) throw new HttpError(404, "NOT_FOUND", "Application not found");
        if (current.status === target) throw new HttpError(409, "INVALID_STATUS", `Application is already ${target}`);
        const updated = await tx.providers.update(id, { status: target, reviewNote: note });
        const owner = await tx.users.findById(current.userId);
        if (target === "approved" && owner.role === "consumer") await tx.users.setRole(owner.id, "provider");
        if (target === "rejected" && owner.role === "provider") await tx.users.setRole(owner.id, "consumer");
        return updated;
      });
      res.json({ provider });
    });

  router.post("/applications/:id/approve", review("approved"));
  router.post("/applications/:id/reject", review("rejected"));

  router.get(
    "/users",
    asyncHandler(async (req, res) => {
      const { role, q } = req.query;
      if (role !== undefined && !ROLES.includes(role)) throw bad("role", "role must be consumer, provider or admin");
      if (q !== undefined && (typeof q !== "string" || q.length > 100)) throw bad("q", "q must be a string of at most 100 chars");
      res.json(await stores.users.list({ role, q, ...parsePaging(req.query) }));
    }),
  );

  return router;
}
