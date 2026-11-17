import { randomBytes } from "node:crypto";

// PaymentProvider interface:
//   charge({ userId, credits, amountFils, currency, idempotencyKey })
//     -> Promise<{ status: 'succeeded'|'failed', ref, failureReason? }>
// A real gateway (e.g. Stripe) can be dropped in behind the same shape.
export function createSimulatedPaymentProvider({ fail = false } = {}) {
  return {
    async charge({ userId, credits, amountFils, currency = "AED", idempotencyKey } = {}) {
      void userId; void credits; void amountFils; void currency; void idempotencyKey;
      const ref = "sim_" + randomBytes(8).toString("hex");
      if (fail) return { status: "failed", ref, failureReason: "simulated payment failure" };
      return { status: "succeeded", ref };
    },
  };
}
