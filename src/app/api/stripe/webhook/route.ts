import Stripe from "stripe";
import { readWebhookBody } from "@/lib/webhook-body";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { recordPurchaseAnalytics } from "@/lib/analytics";
import { db } from "@/lib/db";
import { processStripeWebhookOnce } from "@/lib/stripe-webhook";
import { markOrderPaid, markOrderPaymentFailed, recordRefund } from "@/lib/payments";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";

function stringId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

async function orderIdFromPaymentIntent(tx: Prisma.TransactionClient, paymentIntentId: string | null) {
  if (!paymentIntentId) return null;
  const order = await tx.order.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true },
  });
  return order?.id ?? null;
}

async function refundOrderId(event: Stripe.Event) {
  if (!["refund.created", "refund.updated"].includes(event.type)) return null;
  const refund = event.data.object as Stripe.Refund;
  if (refund.status !== "succeeded") return null;
  const paymentIntentId = stringId(refund.payment_intent);
  if (!paymentIntentId) throw new Error("Refund is missing payment intent.");
  const linked = await db.order.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, select: { id: true } });
  if (linked) return linked.id;
  // Stripe does not guarantee event order. Resolve trusted intent metadata before
  // opening a transaction; a refund preceding fulfillment must remain retryable.
  const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
  const { orderId, tenantId } = intent.metadata;
  if (!orderId || !tenantId) return null; // Another application's payment.
  const order = await db.order.findFirst({ where: { id: orderId, tenantId }, select: { id: true } });
  return order?.id ?? null;
}

async function processEvent(event: Stripe.Event, tx: Prisma.TransactionClient, resolvedRefundOrderId: string | null) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;
      if (!orderId) return;

      if (session.payment_status !== "paid") {
        return;
      }

      const email = session.customer_details?.email ?? session.customer_email;
      if (!email) throw new Error("Paid checkout session is missing customer email.");

      await markOrderPaid({
        orderId,
        email,
        customerName: session.customer_details?.name ?? null,
        stripeCustomerId: stringId(session.customer),
        stripePaymentIntentId: stringId(session.payment_intent),
        checkoutEvidence: {
          sessionId: session.id,
          tenantId: session.metadata?.tenantId ?? null,
          amountTotal: session.amount_total,
          currency: session.currency,
          mode: session.mode,
          paymentStatus: session.payment_status,
        },
      }, tx);
      return;
    }

    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;
      if (!orderId) return;
      await tx.order.updateMany({
        where: {
          id: orderId,
          status: { in: ["PENDING", "CHECKOUT_CREATED", "PAYMENT_FAILED"] },
        },
        data: { status: "CANCELED", canceledAt: new Date() },
      });
      return;
    }

    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;
      if (!orderId) return;
      await markOrderPaymentFailed({
        orderId,
        stripePaymentIntentId: stringId(session.payment_intent),
        failureMessage: "Stripe Checkout reported asynchronous payment failure.",
      }, tx);
      return;
    }

    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const orderId =
        intent.metadata?.orderId ?? (await orderIdFromPaymentIntent(tx, intent.id));
      if (!orderId) return;
      await markOrderPaymentFailed({
        orderId,
        stripePaymentIntentId: intent.id,
        failureCode: intent.last_payment_error?.code ?? null,
        failureMessage: intent.last_payment_error?.message ?? null,
      }, tx);
      return;
    }

    case "refund.created":
    case "refund.updated": {
      const refund = event.data.object as Stripe.Refund;
      if (refund.status !== "succeeded") return;
      const paymentIntentId = stringId(refund.payment_intent);
      const orderId = resolvedRefundOrderId;
      if (!orderId) return;
      await recordRefund({
        orderId,
        providerRefundId: refund.id,
        stripePaymentIntentId: paymentIntentId,
        amountCents: refund.amount,
        reason: refund.reason ?? null,
      }, tx);
      return;
    }
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readWebhookBody(request);
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      getStripeWebhookSecret(),
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid Stripe webhook." },
      { status: 400 },
    );
  }

  try {
    const resolvedRefundOrderId = await refundOrderId(event);
    const result = await processStripeWebhookOnce("PAYMENTS", event, (tx) => processEvent(event, tx, resolvedRefundOrderId));
    if (!result.duplicate && ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === "paid" && session.metadata?.orderId) {
        await recordPurchaseAnalytics(session.metadata.orderId).catch(() => {
          console.error("Unable to record purchase analytics");
        });
      }
    }
    return NextResponse.json({ received: true, ...result });
  } catch {
    console.error("Stripe webhook processing failed");
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
