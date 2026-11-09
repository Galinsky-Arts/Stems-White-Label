import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { db } from "@/lib/db";

export type CommerceAccountSnapshot = {
  stripeAccountId: string;
  country: string | null;
  defaultCurrency: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  requirementsCurrentlyDue: string[];
  requirementsEventuallyDue: string[];
  requirementsPastDue: string[];
  requirementsPendingVerification: string[];
  accountCreatedAt: Date | null;
};

export function normalizeConnectCountry(value: unknown) {
  const country =
    typeof value === "string" && value.trim()
      ? value.trim().toUpperCase()
      : (process.env.STRIPE_CONNECT_DEFAULT_COUNTRY ?? "US").trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("Stripe Connect country must be a two-letter ISO country code.");
  }
  return country;
}

export function normalizePlatformFeeBps(value: unknown) {
  const fee = Number(value);
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10000) {
    throw new Error("Platform fee must be an integer from 0 to 10000 basis points.");
  }
  return fee;
}

export function platformFeeBpsFromEnv() {
  return normalizePlatformFeeBps(process.env.STRIPE_PLATFORM_FEE_BPS ?? 0);
}

export function calculatePlatformFeeCents(amountCents: number, feeBps: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new Error("Settlement amount must be a non-negative integer.");
  }
  const normalizedBps = normalizePlatformFeeBps(feeBps);
  return Math.min(
    amountCents,
    Math.round((amountCents * normalizedBps) / 10000),
  );
}

export function commerceReadiness(input: {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
}) {
  const ready =
    Boolean(input.stripeAccountId) &&
    input.chargesEnabled &&
    input.payoutsEnabled &&
    input.detailsSubmitted &&
    !input.disabledReason;

  let status: "NOT_CONNECTED" | "ONBOARDING" | "RESTRICTED" | "READY";
  if (!input.stripeAccountId) status = "NOT_CONNECTED";
  else if (ready) status = "READY";
  else if (input.detailsSubmitted || input.disabledReason) status = "RESTRICTED";
  else status = "ONBOARDING";

  return { ready, status };
}

export function stripeAccountSnapshot(account: Stripe.Account): CommerceAccountSnapshot {
  return {
    stripeAccountId: account.id,
    country: account.country ?? null,
    defaultCurrency: account.default_currency ?? null,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    disabledReason: account.requirements?.disabled_reason ?? null,
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    requirementsEventuallyDue: account.requirements?.eventually_due ?? [],
    requirementsPastDue: account.requirements?.past_due ?? [],
    requirementsPendingVerification:
      account.requirements?.pending_verification ?? [],
    accountCreatedAt: account.created
      ? new Date(account.created * 1000)
      : null,
  };
}

export async function ensureTenantCommerce(tenantId: string) {
  return db.tenantCommerce.upsert({
    where: { tenantId },
    update: {},
    create: {
      tenantId,
      platformFeeBps: platformFeeBpsFromEnv(),
    },
  });
}

export async function persistTenantCommerceAccount(
  tenantId: string,
  snapshot: CommerceAccountSnapshot,
  transaction?: Prisma.TransactionClient,
) {
  const client = transaction ?? db;
  const existing = await client.tenantCommerce.findUnique({
    where: { tenantId },
  });

  if (
    existing?.stripeAccountId &&
    existing.stripeAccountId !== snapshot.stripeAccountId
  ) {
    throw new Error("Tenant is already linked to a different Stripe account.");
  }

  const now = new Date();
  return client.tenantCommerce.upsert({
    where: { tenantId },
    create: {
      tenantId,
      stripeAccountId: snapshot.stripeAccountId,
      country: snapshot.country,
      defaultCurrency: snapshot.defaultCurrency,
      chargesEnabled: snapshot.chargesEnabled,
      payoutsEnabled: snapshot.payoutsEnabled,
      detailsSubmitted: snapshot.detailsSubmitted,
      disabledReason: snapshot.disabledReason,
      requirementsCurrentlyDue: snapshot.requirementsCurrentlyDue,
      requirementsEventuallyDue: snapshot.requirementsEventuallyDue,
      requirementsPastDue: snapshot.requirementsPastDue,
      requirementsPendingVerification: snapshot.requirementsPendingVerification,
      platformFeeBps: platformFeeBpsFromEnv(),
      accountCreatedAt: snapshot.accountCreatedAt,
      onboardingCompletedAt: snapshot.detailsSubmitted ? now : null,
      lastSyncedAt: now,
    },
    update: {
      stripeAccountId: snapshot.stripeAccountId,
      country: snapshot.country,
      defaultCurrency: snapshot.defaultCurrency,
      chargesEnabled: snapshot.chargesEnabled,
      payoutsEnabled: snapshot.payoutsEnabled,
      detailsSubmitted: snapshot.detailsSubmitted,
      disabledReason: snapshot.disabledReason,
      requirementsCurrentlyDue: snapshot.requirementsCurrentlyDue,
      requirementsEventuallyDue: snapshot.requirementsEventuallyDue,
      requirementsPastDue: snapshot.requirementsPastDue,
      requirementsPendingVerification: snapshot.requirementsPendingVerification,
      accountCreatedAt: snapshot.accountCreatedAt,
      onboardingCompletedAt: snapshot.detailsSubmitted
        ? existing?.onboardingCompletedAt ?? now
        : null,
      lastSyncedAt: now,
    },
  });
}

export async function getTenantCommerceState(tenantId: string) {
  const commerce = await ensureTenantCommerce(tenantId);
  return {
    ...commerce,
    ...commerceReadiness(commerce),
  };
}

export async function getTenantCommerceForCheckout(
  tenantId: string,
  totalCents: number,
) {
  const commerce = await db.tenantCommerce.findUnique({
    where: { tenantId },
  });

  if (!commerce) {
    throw new Error("This storefront has not connected a merchant account yet.");
  }

  const readiness = commerceReadiness(commerce);
  if (!readiness.ready || !commerce.stripeAccountId) {
    throw new Error(
      "This storefront is not currently ready to accept payments. Please try again later.",
    );
  }

  return {
    stripeAccountId: commerce.stripeAccountId,
    platformFeeBps: commerce.platformFeeBps,
    platformFeeCents: calculatePlatformFeeCents(
      totalCents,
      commerce.platformFeeBps,
    ),
  };
}

/** Refresh is a return from an owner-started onboarding flow, not an initiation endpoint. */
export function onboardingRefreshAllowed(state: {
  stripeAccountId: string | null;
  onboardingStartedAt: Date | null;
} | null, now = new Date()) {
  const age = state?.onboardingStartedAt ? now.getTime() - state.onboardingStartedAt.getTime() : -1;
  return Boolean(state?.stripeAccountId) && age >= 0 && age <= 30 * 60 * 1000;
}
