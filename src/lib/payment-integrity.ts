/**
 * Pure payment-ledger invariants (ported from #34). Used by the Stripe payment
 * lifecycle in payments.ts and independently unit tested.
 */
export const SETTLED_ORDER_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

export function isSettledOrderStatus(status: string) {
  return (SETTLED_ORDER_STATUSES as readonly string[]).includes(status);
}

/** Refunds must be positive integer cents and never exceed captured funds. */
export function assertRefundAmounts(input: {
  capturedCents: number;
  previousRefundsCents: number;
  refundCents: number;
}) {
  const { capturedCents, previousRefundsCents, refundCents } = input;
  if (!Number.isSafeInteger(refundCents) || refundCents <= 0) {
    throw new Error("Refund amount must be a positive integer.");
  }
  if (![capturedCents, previousRefundsCents].every(Number.isSafeInteger) ||
      capturedCents <= 0 || previousRefundsCents < 0 ||
      previousRefundsCents + refundCents > capturedCents) {
    throw new Error("Refund total exceeds the payment amount.");
  }
  return previousRefundsCents + refundCents;
}

/** A replayed provider refund ID must keep its owning payment and amount. */
export function assertRefundReplay(
  existing: { paymentId: string; amountCents: number },
  attempted: { paymentId: string; amountCents: number },
) {
  if (existing.paymentId !== attempted.paymentId || existing.amountCents !== attempted.amountCents) {
    throw new Error("Refund does not match the recorded payment.");
  }
}

/**
 * Settled orders are immutable to payment-success replays: the caller returns
 * the stored order unchanged (idempotent 200) and must not re-grant rights.
 * Returns true when the event is a replay that must not mutate state.
 */
export function isPaymentReplayOfSettledOrder(status: string) {
  return isSettledOrderStatus(status);
}

export type PaymentSuccessDisposition = "fulfill" | "replay" | "reconcile";

/**
 * Decide what a provider "payment succeeded" event may do to an order.
 * - settled orders: idempotent replay, never re-grant rights;
 * - CANCELED orders: money arrived after cancellation. Access must NOT be
 *   granted; the payment is recorded and the order is flagged so an admin
 *   refunds it (or auto-refund does when enabled).
 * - otherwise: fulfill.
 */
export function paymentSuccessDisposition(status: string): PaymentSuccessDisposition {
  if (isSettledOrderStatus(status)) return "replay";
  if (status === "CANCELED") return "reconcile";
  return "fulfill";
}

/** Refunds are accepted for settled orders and for flagged late payments on canceled orders. */
export function refundAllowedForOrder(order: { status: string; reconciliation?: string | null }) {
  return isSettledOrderStatus(order.status) || (order.status === "CANCELED" && Boolean(order.reconciliation));
}

export function autoRefundCanceledPaymentsEnabled(env: Record<string, string | undefined> = process.env) {
  return env.STEMS_AUTO_REFUND_CANCELED_PAYMENTS === "true";
}
