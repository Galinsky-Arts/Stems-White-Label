import assert from "node:assert/strict";
import type Stripe from "stripe";
import StripeSdk from "stripe";
import { db } from "../src/lib/db";
import { getStripe } from "../src/lib/stripe";
import { POST as billingWebhook } from "../src/app/api/stripe/billing/webhook/route";
import { POST as connectWebhook } from "../src/app/api/stripe/connect/webhook/route";

/** Signed route and database tests with offline provider fixtures; no provider writes. */
export async function validateWebhookSecurity(suffix: string) {
  const tenant = await db.tenant.create({ data: { name: "Webhook security fixture", slug: "webhook-security-" + suffix } });
  const ids: string[] = [];
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_offline_billing_fixture";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_offline_connect_fixture";
  const stripe = getStripe();
  const saved = { subscription: stripe.subscriptions.retrieve, price: stripe.prices.retrieve, account: stripe.accounts.retrieve };
  const customerId = "cus_security_" + suffix;
  const subscriptionId = "sub_security_" + suffix;
  const sessionId = "cs_security_" + suffix;
  const accountId = "acct_security_" + suffix;
  let status: Stripe.Subscription.Status = "active";
  let providerFailure = false;
  let accountReads = 0;
  const subscription = () => ({
    id: subscriptionId, customer: customerId, status,
    metadata: { tenantId: tenant.id }, cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_security" }, current_period_start: 1790000000, current_period_end: 1792592000 }] },
  });
  stripe.subscriptions.retrieve = (async (id: string) => {
    assert.equal(id, subscriptionId);
    if (providerFailure) throw new Error("Provider diagnostics with secret and customer data");
    return subscription();
  }) as unknown as typeof stripe.subscriptions.retrieve;
  stripe.prices.retrieve = (async () => ({
    id: "price_security", type: "recurring", active: true, unit_amount: 1000,
    currency: "usd", recurring: { interval: "month", interval_count: 1 },
    metadata: {}, product: { id: "prod_security", name: "Security fixture", active: true, metadata: {
      stems_plan_key: "security", stems_max_works: "10", stems_max_storage_bytes: "1000000",
      stems_max_custom_domains: "1", stems_max_members: "3", stems_allow_custom_domains: "true", stems_allow_white_label: "true",
    } },
  })) as unknown as typeof stripe.prices.retrieve;
  stripe.accounts.retrieve = (async (id: string) => {
    assert.equal(id, accountId); accountReads++;
    if (providerFailure) throw new Error("Provider diagnostics with secret and customer data");
    return { id: accountId, country: "US", default_currency: "usd", charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: {}, created: 1790000000 };
  }) as unknown as typeof stripe.accounts.retrieve;
  async function deliver(scope: "billing" | "connect", id: string, type: string, object: unknown) {
    ids.push(id);
    const payload = JSON.stringify({ id, type, data: { object } });
    const secret = scope === "billing" ? process.env.STRIPE_BILLING_WEBHOOK_SECRET! : process.env.STRIPE_CONNECT_WEBHOOK_SECRET!;
    const signature = StripeSdk.webhooks.generateTestHeaderString({ payload, secret });
    return (scope === "billing" ? billingWebhook : connectWebhook)(new Request("https://store.example/api/stripe/" + scope + "/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }));
  }
  try {
    await db.tenantSubscription.create({ data: { tenantId: tenant.id, stripeCustomerId: customerId, stripeCheckoutSessionId: sessionId } });
    await db.tenantCommerce.create({ data: { tenantId: tenant.id, stripeAccountId: accountId } });
    const checkout = { id: sessionId, mode: "subscription", subscription: subscriptionId, customer: customerId, metadata: { tenantId: tenant.id } };
    const checkoutId = "evt_billing_checkout_" + suffix;
    const responses = await Promise.all(Array.from({ length: 3 }, () => deliver("billing", checkoutId, "checkout.session.completed", checkout)));
    assert.ok(responses.every((response) => response.status === 200));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(bodies.filter((body) => body.duplicate === false).length, 1);
    assert.equal((await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).status, "ACTIVE");

    // Ignore stale event snapshots and synchronize the current provider state.
    status = "canceled";
    assert.equal((await deliver("billing", "evt_billing_stale_" + suffix, "customer.subscription.updated", { ...subscription(), status: "active" })).status, 200);
    assert.equal((await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).status, "CANCELED");
    const wrongId = "evt_billing_wrong_customer_" + suffix;
    assert.equal((await deliver("billing", wrongId, "checkout.session.completed", { ...checkout, customer: "cus_wrong" })).status, 500);
    assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: wrongId } }), 0);
    assert.equal((await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).stripeCustomerId, customerId);

    const connectId = "evt_connect_security_" + suffix;
    const oldAccount = { id: accountId, charges_enabled: false, payouts_enabled: false };
    providerFailure = true;
    const failed = await deliver("connect", connectId, "account.updated", oldAccount);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Connect webhook processing failed." });
    assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: connectId } }), 0);
    assert.equal((await db.tenantCommerce.findUniqueOrThrow({ where: { tenantId: tenant.id } })).chargesEnabled, false);
    providerFailure = false;
    const successful = await Promise.all(Array.from({ length: 3 }, () => deliver("connect", connectId, "account.updated", oldAccount)));
    assert.ok(successful.every((response) => response.status === 200));
    assert.equal(accountReads, 2); // Failed attempt plus exactly one committed retry.
    const commerce = await db.tenantCommerce.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    assert.equal(commerce.chargesEnabled, true);
    assert.equal(commerce.payoutsEnabled, true);
    assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: connectId } }), 1);
  } finally {
    stripe.subscriptions.retrieve = saved.subscription;
    stripe.prices.retrieve = saved.price;
    stripe.accounts.retrieve = saved.account;
    await db.stripeWebhookEvent.deleteMany({ where: { providerEventId: { in: ids } } });
    await db.tenant.delete({ where: { id: tenant.id } });
  }
}
