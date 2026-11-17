import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

/** Orders that captured money after cancellation and still need an admin decision. */
export async function listOrdersNeedingReconciliation(tenantId: string) {
  return db.order.findMany({
    where: { tenantId, reconciliation: { in: ["NEEDS_REVIEW", "REFUND_REQUESTED"] } },
    orderBy: { reconciliationFlaggedAt: "desc" },
    select: {
      id: true,
      buyerEmail: true,
      totalCents: true,
      currency: true,
      reconciliation: true,
      reconciliationNote: true,
      reconciliationFlaggedAt: true,
      canceledAt: true,
      stripePaymentIntentId: true,
    },
    take: 100,
  });
}

/**
 * Ask Stripe to refund a payment captured for a canceled order. Uses an
 * idempotency key per order so retries/double clicks issue one refund. The
 * refund webhook later records the Refund row and resolves the order.
 */
export async function requestCanceledOrderRefund(tenantId: string, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, tenantId, status: "CANCELED", reconciliation: { in: ["NEEDS_REVIEW", "REFUND_REQUESTED"] } },
    select: { id: true, stripePaymentIntentId: true, stripeConnectedAccountId: true },
  });
  if (!order) throw new Error("Order is not awaiting a cancellation refund.");
  if (!order.stripePaymentIntentId) throw new Error("Order has no captured payment to refund.");

  await getStripe().refunds.create(
    {
      payment_intent: order.stripePaymentIntentId,
      reason: "requested_by_customer",
      metadata: { orderId: order.id, tenantId, cause: "payment_after_cancellation" },
      // Destination charges: pull the transfer and platform fee back as well.
      ...(order.stripeConnectedAccountId ? { reverse_transfer: true, refund_application_fee: true } : {}),
    },
    { idempotencyKey: "canceled-order-refund-" + order.id },
  );

  await db.order.updateMany({
    where: { id: order.id, reconciliation: "NEEDS_REVIEW" },
    data: { reconciliation: "REFUND_REQUESTED", reconciliationNote: "Refund requested from Stripe; awaiting refund webhook." },
  });
}

/** Admin closes the review without a Stripe refund (e.g. handled out of band). Access is still never granted. */
export async function resolveCanceledOrderPayment(tenantId: string, orderId: string, note: string) {
  const trimmed = note.trim().slice(0, 500);
  if (!trimmed) throw new Error("A resolution note is required.");
  const result = await db.order.updateMany({
    where: { id: orderId, tenantId, status: "CANCELED", reconciliation: { in: ["NEEDS_REVIEW", "REFUND_REQUESTED"] } },
    data: { reconciliation: "RESOLVED", reconciliationResolvedAt: new Date(), reconciliationNote: "Resolved by admin: " + trimmed },
  });
  if (result.count !== 1) throw new Error("Order is not awaiting reconciliation.");
}
