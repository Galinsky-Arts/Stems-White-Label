export type CheckoutPaymentEvidence = {
  sessionId: string;
  tenantId: string | null;
  amountTotal: number | null;
  currency: string | null;
  mode: string | null;
  paymentStatus: string;
};

export function assertCheckoutPaymentMatches(order: {
  tenantId: string;
  stripeCheckoutSessionId: string | null;
  totalCents: number;
  currency: string;
}, evidence: CheckoutPaymentEvidence) {
  if (evidence.mode !== "payment" || evidence.paymentStatus !== "paid" ||
      !order.stripeCheckoutSessionId || evidence.sessionId !== order.stripeCheckoutSessionId ||
      evidence.tenantId !== order.tenantId || !Number.isSafeInteger(evidence.amountTotal) ||
      evidence.amountTotal !== order.totalCents || !evidence.currency ||
      evidence.currency.toUpperCase() !== order.currency.toUpperCase()) {
    throw new Error("Checkout payment does not match order.");
  }
}
