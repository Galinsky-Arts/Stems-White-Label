import type { Prisma } from "@prisma/client";
import { processStripeWebhookOnce } from "@/lib/stripe-webhook";
import Stripe from "stripe";
import { readWebhookBody } from "@/lib/webhook-body";
import { NextResponse } from "next/server";

import {
  syncStripeSubscription,
} from "@/lib/billing";
import {
  getStripe,
  getStripeBillingWebhookSecret,
} from "@/lib/stripe";
import {
  syncSubscriptionFromCheckoutSession,
} from "@/lib/stripe-billing";

export const runtime = "nodejs";

async function tenantIdForSubscription(subscription: Stripe.Subscription, tx: Prisma.TransactionClient) {
  if (subscription.metadata?.tenantId) {
    return subscription.metadata.tenantId;
  }

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  const billing = await tx.tenantSubscription.findFirst({
    where: {
      OR: [
        { stripeSubscriptionId: subscription.id },
        { stripeCustomerId: customerId },
      ],
    },
    select: { tenantId: true },
  });

  return billing?.tenantId ?? null;
}

async function processEvent(event: Stripe.Event, tx: Prisma.TransactionClient) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const tenantId =
        session.metadata?.tenantId ?? session.client_reference_id;
      if (!tenantId) return;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"billing:" + tenantId}, 0))::text`;
      await syncSubscriptionFromCheckoutSession(tenantId, session, tx);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const tenantId = await tenantIdForSubscription(subscription, tx);
      if (!tenantId) return;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"billing:" + tenantId}, 0))::text`;
      const current = await getStripe().subscriptions.retrieve(subscription.id);
      await syncStripeSubscription(tenantId, current, tx);
      return;
    }
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Stripe signature." },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readWebhookBody(request);
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      getStripeBillingWebhookSecret(),
    );
  } catch {
    return NextResponse.json({ error: "Invalid Stripe Billing webhook." }, { status: 400 });
  }

  try {
    const result = await processStripeWebhookOnce("BILLING", event, (tx) => processEvent(event, tx));
    return NextResponse.json({ received: true, ...result });
  } catch {
    console.error("Stripe Billing webhook processing failed");
    return NextResponse.json({ error: "Billing webhook processing failed." }, { status: 500 });
  }
}
