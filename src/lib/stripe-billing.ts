import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { db } from "@/lib/db";
import {
  ensureTenantSubscription,
  getBillingPlan,
  listBillingPlans,
  subscriptionAccessState,
  syncStripeSubscription,
} from "@/lib/billing";
import { getStripe } from "@/lib/stripe";

function stringId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

export async function createSaasCheckoutSession(input: {
  tenantId: string;
  tenantName: string;
  email?: string | null;
  priceId: string;
  origin: string;
}) {
  const stripe = getStripe();
  const plan = await getBillingPlan(input.priceId);
  const billing = await ensureTenantSubscription(input.tenantId);
  const access = subscriptionAccessState(billing);

  if (
    billing.stripeSubscriptionId &&
    !["CANCELED", "INCOMPLETE_EXPIRED"].includes(billing.status)
  ) {
    throw new Error(
      access.allowed
        ? "This tenant already has a subscription. Use Manage billing to change plans."
        : "This tenant already has a Stripe subscription. Use Manage billing to resolve it.",
    );
  }

  let customerId = billing.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: input.email ?? undefined,
      name: input.tenantName,
      metadata: { tenantId: input.tenantId },
    });
    customerId = customer.id;

    await db.tenantSubscription.update({
      where: { tenantId: input.tenantId },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: input.tenantId,
    success_url: input.origin + "/admin/billing?checkout=success",
    cancel_url: input.origin + "/admin/billing?checkout=canceled",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    metadata: {
      tenantId: input.tenantId,
      billingPriceId: plan.priceId,
    },
    subscription_data: {
      metadata: {
        tenantId: input.tenantId,
        billingPriceId: plan.priceId,
      },
      trial_period_days: plan.trialDays > 0 ? plan.trialDays : undefined,
    },
  });

  if (!session.url) throw new Error("Stripe did not return a SaaS Checkout URL.");

  await db.tenantSubscription.update({
    where: { tenantId: input.tenantId },
    data: {
      stripeCheckoutSessionId: session.id,
      stripeCustomerId: customerId,
    },
  });

  return session.url;
}

export async function createSaasPortalSession(input: {
  tenantId: string;
  origin: string;
}) {
  const billing = await ensureTenantSubscription(input.tenantId);
  if (!billing.stripeCustomerId) {
    throw new Error("This tenant does not have a Stripe Billing customer yet.");
  }

  const configuration = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim();
  const session = await getStripe().billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: input.origin + "/admin/billing",
    configuration: configuration || undefined,
  });

  return session.url;
}

export async function refreshTenantStripeSubscription(tenantId: string) {
  const billing = await ensureTenantSubscription(tenantId);
  if (!billing.stripeSubscriptionId) return billing;

  const subscription = await getStripe().subscriptions.retrieve(
    billing.stripeSubscriptionId,
  );
  return syncStripeSubscription(tenantId, subscription);
}

export async function syncSubscriptionFromCheckoutSession(
  tenantId: string,
  session: Stripe.Checkout.Session,
  transaction?: Prisma.TransactionClient,
) {
  const client = transaction ?? db;
  const subscriptionId = stringId(session.subscription);
  const customerId = stringId(session.customer);
  if (!subscriptionId || !customerId) throw new Error("Subscription Checkout session is missing Stripe identifiers.");
  const existing = await client.tenantSubscription.findUnique({ where: { tenantId } });
  if (!existing || existing.stripeCustomerId !== customerId || existing.stripeCheckoutSessionId !== session.id) {
    throw new Error("Subscription checkout does not match tenant.");
  }
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  return syncStripeSubscription(tenantId, subscription, transaction);
}

export { listBillingPlans };
