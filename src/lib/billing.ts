import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export type BillingPlan = {
  priceId: string;
  productId: string;
  key: string;
  name: string;
  description: string | null;
  currency: string;
  unitAmountCents: number;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  trialDays: number;
  maxWorks: number | null;
  maxStorageBytes: bigint | null;
  maxCustomDomains: number | null;
  maxMembers: number | null;
  allowCustomDomains: boolean;
  allowWhiteLabel: boolean;
  features: string[];
};

type SubscriptionEntitlements = Pick<
  BillingPlan,
  | "maxWorks"
  | "maxStorageBytes"
  | "maxCustomDomains"
  | "maxMembers"
  | "allowCustomDomains"
  | "allowWhiteLabel"
>;

type SubscriptionLike = {
  status: string;
  pastDueGraceUntil: Date | null;
};

function csv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function allowedBillingPriceIds() {
  return [...new Set(csv(process.env.STRIPE_BILLING_PRICE_IDS))];
}

function metadataValue(
  metadata: Record<string, string>,
  key: string,
) {
  const value = metadata[key]?.trim();
  if (!value) throw new Error("Billing product is missing metadata " + key + ".");
  return value;
}

function metadataLimit(
  metadata: Record<string, string>,
  key: string,
  bigint = false,
) {
  const raw = metadataValue(metadata, key).toLowerCase();
  if (raw === "unlimited") return null;

  if (!/^\d+$/.test(raw)) {
    throw new Error(key + " must be a non-negative integer or unlimited.");
  }

  if (bigint) return BigInt(raw);

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(key + " exceeds the supported integer range.");
  }
  return value;
}

function metadataBoolean(
  metadata: Record<string, string>,
  key: string,
) {
  const raw = metadataValue(metadata, key).toLowerCase();
  if (raw !== "true" && raw !== "false") {
    throw new Error(key + " must be true or false.");
  }
  return raw === "true";
}

function metadataTrialDays(metadata: Record<string, string>) {
  const raw = metadata["stems_trial_days"]?.trim() ?? "0";
  if (!/^\d+$/.test(raw)) {
    throw new Error("stems_trial_days must be a non-negative integer.");
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days > 365) {
    throw new Error("stems_trial_days must be from 0 to 365.");
  }
  return days;
}

export function parseBillingPlan(
  price: Stripe.Price,
  options: { requireActive?: boolean } = {},
): BillingPlan {
  const requireActive = options.requireActive !== false;
  if (
    price.type !== "recurring" ||
    !price.recurring ||
    (requireActive && !price.active)
  ) {
    throw new Error(
      requireActive
        ? "Configured SaaS price must be an active recurring Stripe Price."
        : "Subscription price must be recurring.",
    );
  }
  if (price.unit_amount == null || price.unit_amount < 0) {
    throw new Error("Configured SaaS price must use a fixed unit amount.");
  }
  if (typeof price.product === "string" || !("name" in price.product)) {
    throw new Error("Stripe Price product must be expanded.");
  }

  const product = price.product as Stripe.Product;
  if (requireActive && !product.active) {
    throw new Error("Configured SaaS product is inactive.");
  }

  const metadata = {
    ...product.metadata,
    ...price.metadata,
  };
  const features = csv(metadata["stems_features"]);

  return {
    priceId: price.id,
    productId: product.id,
    key: metadataValue(metadata, "stems_plan_key"),
    name: product.name,
    description: product.description ?? null,
    currency: price.currency.toUpperCase(),
    unitAmountCents: price.unit_amount,
    interval: price.recurring.interval,
    intervalCount: price.recurring.interval_count,
    trialDays: metadataTrialDays(metadata),
    maxWorks: metadataLimit(metadata, "stems_max_works") as number | null,
    maxStorageBytes: metadataLimit(
      metadata,
      "stems_max_storage_bytes",
      true,
    ) as bigint | null,
    maxCustomDomains: metadataLimit(
      metadata,
      "stems_max_custom_domains",
    ) as number | null,
    maxMembers: metadataLimit(
      metadata,
      "stems_max_members",
    ) as number | null,
    allowCustomDomains: metadataBoolean(
      metadata,
      "stems_allow_custom_domains",
    ),
    allowWhiteLabel: metadataBoolean(metadata, "stems_allow_white_label"),
    features,
  };
}

async function retrieveBillingPlan(
  priceId: string,
  options: { requireActive?: boolean } = {},
) {
  const price = await getStripe().prices.retrieve(priceId, {
    expand: ["product"],
  });
  return parseBillingPlan(price, options);
}

export async function getBillingPlan(priceId: string) {
  const allowed = allowedBillingPriceIds();
  if (!allowed.includes(priceId)) {
    throw new Error("That SaaS billing plan is not available.");
  }
  return retrieveBillingPlan(priceId);
}

export async function listBillingPlans() {
  const ids = allowedBillingPriceIds();
  const plans = await Promise.all(ids.map((id) => getBillingPlan(id)));
  return plans;
}

export function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
) {
  return status.toUpperCase() as
    | "TRIALING"
    | "ACTIVE"
    | "PAST_DUE"
    | "CANCELED"
    | "UNPAID"
    | "INCOMPLETE"
    | "INCOMPLETE_EXPIRED"
    | "PAUSED";
}

function dateFromUnix(value: number | null | undefined) {
  return value == null ? null : new Date(value * 1000);
}

function pastDueGraceDays() {
  const raw = Number(process.env.SAAS_PAST_DUE_GRACE_DAYS ?? 7);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30) : 7;
}

function nextGraceDate(now = new Date()) {
  return new Date(
    now.getTime() + pastDueGraceDays() * 24 * 60 * 60 * 1000,
  );
}

export function subscriptionAccessState(
  subscription: SubscriptionLike | null | undefined,
  now = new Date(),
) {
  if (!subscription) {
    return { allowed: false, reason: "A SaaS subscription is required." };
  }

  if (
    subscription.status === "GRANDFATHERED" ||
    subscription.status === "ACTIVE" ||
    subscription.status === "TRIALING"
  ) {
    return { allowed: true, reason: null };
  }

  if (
    subscription.status === "PAST_DUE" &&
    subscription.pastDueGraceUntil &&
    subscription.pastDueGraceUntil > now
  ) {
    return {
      allowed: true,
      reason: "Subscription payment is past due and currently within its grace period.",
    };
  }

  return {
    allowed: false,
    reason:
      subscription.status === "PAST_DUE"
        ? "Subscription payment is past due and its grace period has ended."
        : "SaaS subscription is not active.",
  };
}

export async function ensureTenantSubscription(tenantId: string) {
  return db.tenantSubscription.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, status: "UNSUBSCRIBED" },
  });
}

export async function persistSubscriptionSnapshot(input: {
  tenantId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: ReturnType<typeof mapStripeSubscriptionStatus>;
  plan: BillingPlan;
  cancelAtPeriodEnd: boolean;
  trialStart: Date | null;
  trialEnd: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  endedAt: Date | null;
}, transaction?: Prisma.TransactionClient) {
  const client = transaction ?? db;
  const existing = await client.tenantSubscription.findUnique({
    where: { tenantId: input.tenantId },
  });

  if (
    existing?.stripeSubscriptionId &&
    existing.stripeSubscriptionId !== input.stripeSubscriptionId &&
    !["CANCELED", "INCOMPLETE_EXPIRED"].includes(existing.status)
  ) {
    throw new Error("Tenant already has a different active Stripe subscription.");
  }

  if (existing?.stripeCustomerId && existing.stripeCustomerId !== input.stripeCustomerId) {
    throw new Error("Billing customer does not match tenant.");
  }

  const now = new Date();
  const grace =
    input.status === "PAST_DUE"
      ? existing?.status === "PAST_DUE" && existing.pastDueGraceUntil
        ? existing.pastDueGraceUntil
        : nextGraceDate(now)
      : null;

  return client.tenantSubscription.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      status: input.status,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePriceId: input.plan.priceId,
      stripeProductId: input.plan.productId,
      planKey: input.plan.key,
      planName: input.plan.name,
      currency: input.plan.currency,
      unitAmountCents: input.plan.unitAmountCents,
      billingInterval: input.plan.interval,
      billingIntervalCount: input.plan.intervalCount,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      trialStart: input.trialStart,
      trialEnd: input.trialEnd,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      canceledAt: input.canceledAt,
      endedAt: input.endedAt,
      pastDueGraceUntil: grace,
      maxWorks: input.plan.maxWorks,
      maxStorageBytes: input.plan.maxStorageBytes,
      maxCustomDomains: input.plan.maxCustomDomains,
      maxMembers: input.plan.maxMembers,
      allowCustomDomains: input.plan.allowCustomDomains,
      allowWhiteLabel: input.plan.allowWhiteLabel,
      entitlements: { features: input.plan.features },
      lastSyncedAt: now,
    },
    update: {
      status: input.status,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePriceId: input.plan.priceId,
      stripeProductId: input.plan.productId,
      planKey: input.plan.key,
      planName: input.plan.name,
      currency: input.plan.currency,
      unitAmountCents: input.plan.unitAmountCents,
      billingInterval: input.plan.interval,
      billingIntervalCount: input.plan.intervalCount,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      trialStart: input.trialStart,
      trialEnd: input.trialEnd,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      canceledAt: input.canceledAt,
      endedAt: input.endedAt,
      pastDueGraceUntil: grace,
      maxWorks: input.plan.maxWorks,
      maxStorageBytes: input.plan.maxStorageBytes,
      maxCustomDomains: input.plan.maxCustomDomains,
      maxMembers: input.plan.maxMembers,
      allowCustomDomains: input.plan.allowCustomDomains,
      allowWhiteLabel: input.plan.allowWhiteLabel,
      entitlements: { features: input.plan.features },
      lastSyncedAt: now,
    },
  });
}

export async function syncStripeSubscription(
  tenantId: string,
  subscription: Stripe.Subscription,
  transaction?: Prisma.TransactionClient,
) {
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no subscription item.");

  const plan = await retrieveBillingPlan(item.price.id, {
    requireActive: false,
  });
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  return persistSubscriptionSnapshot({
    tenantId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    status: mapStripeSubscriptionStatus(subscription.status),
    plan,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialStart: dateFromUnix(subscription.trial_start),
    trialEnd: dateFromUnix(subscription.trial_end),
    currentPeriodStart: dateFromUnix(item.current_period_start),
    currentPeriodEnd: dateFromUnix(item.current_period_end),
    canceledAt: dateFromUnix(subscription.canceled_at),
    endedAt: dateFromUnix(subscription.ended_at),
  }, transaction);
}

export async function getTenantUsage(tenantId: string) {
  const [
    works,
    audio,
    artwork,
    themeAssets,
    packages,
    customDomains,
    members,
  ] = await Promise.all([
    db.work.count({
      where: { tenantId, status: { not: "ARCHIVED" } },
    }),
    db.audioAsset.aggregate({
      where: {
        tenantId,
        status: { not: "ARCHIVED" },
        sizeBytes: { not: null },
      },
      _sum: { sizeBytes: true },
    }),
    db.artworkAsset.aggregate({
      where: { tenantId },
      _sum: { sizeBytes: true },
    }),
    db.themeAsset.aggregate({
      where: { tenantId },
      _sum: { sizeBytes: true },
    }),
    db.downloadPackage.aggregate({
      where: { tenantId, sizeBytes: { not: null } },
      _sum: { sizeBytes: true },
    }),
    db.tenantDomain.count({
      where: { tenantId, verificationToken: { not: null } },
    }),
    db.tenantMembership.count({ where: { tenantId } }),
  ]);

  const storageBytes =
    (audio._sum.sizeBytes ?? 0n) +
    (artwork._sum.sizeBytes ?? 0n) +
    (themeAssets._sum.sizeBytes ?? 0n) +
    (packages._sum.sizeBytes ?? 0n);

  return {
    works,
    storageBytes,
    customDomains,
    members,
  };
}

export async function getTenantBillingState(tenantId: string) {
  const subscription = await ensureTenantSubscription(tenantId);
  const usage = await getTenantUsage(tenantId);
  return {
    subscription,
    usage,
    access: subscriptionAccessState(subscription),
  };
}

function enforceLimit(
  label: string,
  used: number | bigint,
  additional: number | bigint,
  limit: number | bigint | null,
) {
  if (limit == null) return;
  if (
    typeof used === "bigint" ||
    typeof additional === "bigint" ||
    typeof limit === "bigint"
  ) {
    if (BigInt(used) + BigInt(additional) > BigInt(limit)) {
      throw new Error(label + " limit reached for the current SaaS plan.");
    }
    return;
  }

  if (used + additional > limit) {
    throw new Error(label + " limit reached for the current SaaS plan.");
  }
}

async function activeSubscription(tenantId: string) {
  const subscription = await ensureTenantSubscription(tenantId);
  const access = subscriptionAccessState(subscription);
  if (!access.allowed) throw new Error(access.reason ?? "SaaS subscription is inactive.");
  return subscription;
}

export async function assertTenantCanCreateWork(tenantId: string) {
  const [subscription, works] = await Promise.all([
    activeSubscription(tenantId),
    db.work.count({
      where: { tenantId, status: { not: "ARCHIVED" } },
    }),
  ]);
  enforceLimit("Work", works, 1, subscription.maxWorks);
}

export async function assertTenantStorageCapacity(
  tenantId: string,
  additionalBytes: number | bigint,
) {
  if (BigInt(additionalBytes) < 0n) {
    throw new Error("Additional storage must be non-negative.");
  }

  const [subscription, usage] = await Promise.all([
    activeSubscription(tenantId),
    getTenantUsage(tenantId),
  ]);
  enforceLimit(
    "Storage",
    usage.storageBytes,
    BigInt(additionalBytes),
    subscription.maxStorageBytes,
  );
}

export async function assertTenantCanRegisterCustomDomain(tenantId: string) {
  const [subscription, domains] = await Promise.all([
    activeSubscription(tenantId),
    db.tenantDomain.count({
      where: { tenantId, verificationToken: { not: null } },
    }),
  ]);

  if (!subscription.allowCustomDomains) {
    throw new Error("Custom domains are not included in the current SaaS plan.");
  }
  enforceLimit(
    "Custom domain",
    domains,
    1,
    subscription.maxCustomDomains,
  );
}

export async function assertTenantCanUseWhiteLabel(tenantId: string) {
  const subscription = await activeSubscription(tenantId);
  if (!subscription.allowWhiteLabel) {
    throw new Error("White-label theming is not included in the current SaaS plan.");
  }
}

export async function assertTenantCanAddMember(tenantId: string) {
  const [subscription, members] = await Promise.all([
    activeSubscription(tenantId),
    db.tenantMembership.count({ where: { tenantId } }),
  ]);
  enforceLimit("Team member", members, 1, subscription.maxMembers);
}
