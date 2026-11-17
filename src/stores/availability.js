import { nextId } from "./memory.js";

const hhmm = (t) => String(t).slice(0, 5);

function mapSlot(r) {
  return {
    id: r.id,
    providerId: r.provider_id,
    weekday: r.weekday,
    startTime: hhmm(r.start_time),
    endTime: hhmm(r.end_time),
  };
}

export function pgAvailabilityRepo(q) {
  return {
    async listByProvider(providerId) {
      const { rows } = await q.query(
        `SELECT id, provider_id, weekday, start_time, end_time FROM availability
         WHERE provider_id = $1 ORDER BY weekday, start_time`,
        [providerId],
      );
      return rows.map(mapSlot);
    },
    async replaceForProvider(providerId, rows) {
      await q.query("DELETE FROM availability WHERE provider_id = $1", [providerId]);
      for (const r of rows) {
        await q.query(
          "INSERT INTO availability (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)",
          [providerId, r.weekday, r.startTime, r.endTime],
        );
      }
      return this.listByProvider(providerId);
    },
  };
}

export function memAvailabilityRepo(state) {
  return {
    async listByProvider(providerId) {
      return state.availability
        .filter((a) => a.providerId === providerId)
        .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))
        .map((a) => ({ ...a }));
    },
    async replaceForProvider(providerId, rows) {
      state.availability = state.availability.filter((a) => a.providerId !== providerId);
      for (const r of rows) {
        state.availability.push({
          id: nextId(state, "availability"),
          providerId,
          weekday: r.weekday,
          startTime: r.startTime,
          endTime: r.endTime,
        });
      }
      return this.listByProvider(providerId);
    },
  };
}
