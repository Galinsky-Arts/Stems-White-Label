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
