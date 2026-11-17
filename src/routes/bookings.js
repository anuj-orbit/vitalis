import express from "express";
import { asyncHandler, requireAuth, requireRole, HttpError } from "../middleware.js";
import { parsePaging } from "../credits.js";
import {
  getSlots, createBooking, getBooking, cancelBooking, completeBooking, listBookings,
} from "../bookings.js";

function idParam(value) {
  if (!/^\d{1,9}$/.test(String(value)) || Number(value) < 1) throw new HttpError(404, "NOT_FOUND", "Not found");
  return Number(value);
}

function optionalId(value, field) {
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(String(value))) throw new HttpError(400, "VALIDATION", `${field} must be an integer`, { field });
  return Number(value);
}

export function slotsHandler(deps) {
  return asyncHandler(async (req, res) => {
    const providerId = idParam(req.params.id);
    res.json(await getSlots(deps, { providerId, date: req.query.date }));
  });
}

export function bookingsRouter(deps) {
  const router = express.Router();
  router.use(requireAuth);

  router.post("/", asyncHandler(async (req, res) => {
    const { providerId, startsAt } = req.body ?? {};
    res.status(201).json(await createBooking(deps, { consumer: req.user, providerId, startsAt }));
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const paging = parsePaging(req.query);
    res.json(await listBookings(deps, {
      actor: req.user, as: req.query.as, scope: req.query.scope, status: req.query.status, ...paging,
    }));
  }));

  router.get("/:id", asyncHandler(async (req, res) => {
    res.json({ booking: await getBooking(deps, { bookingId: idParam(req.params.id), actor: req.user }) });
  }));

  router.post("/:id/cancel", asyncHandler(async (req, res) => {
    res.json(await cancelBooking(deps, { bookingId: idParam(req.params.id), actor: req.user }));
  }));

  router.post("/:id/complete", asyncHandler(async (req, res) => {
    res.json(await completeBooking(deps, { bookingId: idParam(req.params.id), actor: req.user }));
  }));

  return router;
}

export function adminBookingsRouter(deps) {
  const router = express.Router();
  router.use(requireRole("admin"));

  router.get("/", asyncHandler(async (req, res) => {
    const paging = parsePaging(req.query);
    const { status } = req.query;
    if (status !== undefined && !["confirmed", "cancelled", "completed"].includes(status)) {
      throw new HttpError(400, "VALIDATION", "invalid status", { field: "status" });
    }
    res.json(await deps.stores.bookings.list({
      status,
      providerId: optionalId(req.query.providerId, "providerId"),
      consumerId: optionalId(req.query.consumerId, "consumerId"),
      order: "desc",
      ...paging,
    }));
  }));

  return router;
}
