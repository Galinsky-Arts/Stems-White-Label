import assert from "node:assert/strict";
import { POST as paymentWebhook } from "../src/app/api/stripe/webhook/route";
import { createPendingOrder, quoteLicenseProducts } from "../src/lib/checkout";
import { db } from "../src/lib/db";
import { requestDownloadPackage } from "../src/lib/download-packages";
import { resetStripeClientForTests } from "../src/lib/stripe";
import {
  checkoutCompleted,
  eventId,
  MOCK_SECRET_KEY,
  MOCK_WEBHOOK_SECRET,
  type MockEvent,
  refundEvent,
  signedRequest,
  startStripeMock,
} from "../fixtures/stripe-mock";

/**
 * Stripe payment lifecycle against real PostgreSQL through the signed webhook
 * route, with fixtures/stripe-mock standing in for the Stripe API. Covers event
 * idempotency, out-of-order refunds, partial/full refunds, refund replay and
 * tampering, and license revocation that later success events cannot undo.
 */
async function main() {
  const suffix = Date.now().toString(36);
  const mock = await startStripeMock();
  process.env.STRIPE_SECRET_KEY = MOCK_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = MOCK_WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = mock.baseUrl;
  resetStripeClientForTests();
  const delivered: string[] = [];
  const deliver = async (event: MockEvent) => {
    delivered.push(event.id);
    const response = await paymentWebhook(signedRequest(event));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const recorded = (id: string) => db.stripeWebhookEvent.count({ where: { providerEventId: id } });

  const tenant = await db.tenant.create({ data: { name: "Stripe Lifecycle " + suffix, slug: "stripe-lifecycle-" + suffix } });
  try {
    const work = await db.work.create({ data: { tenantId: tenant.id, slug: "lifecycle-" + suffix, title: "Lifecycle", status: "PUBLISHED", publishedAt: new Date() } });
    const stem = await db.stemGroup.create({ data: { workId: work.id, slug: "drums", label: "Drums" } });
    await db.audioAsset.create({ data: { tenantId: tenant.id, workId: work.id, stemGroupId: stem.id, kind: "STEM", status: "READY",
      fileName: "drums.wav", storageKey: "lifecycle/" + suffix + "/drums.wav", mimeType: "audio/wav", sizeBytes: BigInt(2048) } });
    const product = await db.licenseProduct.create({ data: { tenantId: tenant.id, workId: work.id, slug: "sync", name: "Sync", scope: "ALL_STEMS",
      versions: { create: { version: 1, priceCents: 10000, currency: "USD", termsText: "Lifecycle fixture terms." } } } });
    const quote = await quoteLicenseProducts(tenant.id, [product.id]);
    const order = await createPendingOrder(tenant.id, quote, true, "buyer-" + suffix + "@example.test");
    const sessionId = "cs_lifecycle_" + suffix;
    const intentId = "pi_lifecycle_" + suffix;
    await db.order.update({ where: { id: order.id }, data: { status: "CHECKOUT_CREATED", stripeCheckoutSessionId: sessionId } });
    mock.paymentIntents.set(intentId, { metadata: { orderId: order.id, tenantId: tenant.id } });
    const capture = (id?: string) => checkoutCompleted({ id, sessionId, orderId: order.id, tenantId: tenant.id,
      paymentIntentId: intentId, amountCents: 10000, email: "Buyer-" + suffix + "@Example.test" });

    // 1. Stripe may deliver a refund before fulfillment. It resolves the order via
    //    the payment intent (stripe-mock), fails, and stays retryable.
    const early = refundEvent({ refundId: "re_early_" + suffix, paymentIntentId: intentId, amountCents: 4000 });
    assert.deepEqual(await deliver(early), { status: 500, body: { error: "Webhook processing failed." } });
    assert.equal(await recorded(early.id), 0, "A failed refund event must remain retryable.");
    assert.ok(mock.requests.includes("GET /v1/payment_intents/" + intentId), "Refund resolution reads the intent from Stripe.");

    // 2. Capture is idempotent per event and per order, including concurrent deliveries.
    const first = capture();
    assert.deepEqual(await deliver(first), { status: 200, body: { received: true, duplicate: false } });
    assert.deepEqual(await deliver(first), { status: 200, body: { received: true, duplicate: true } });
    const replays = await Promise.all([capture(), capture(), capture()].map(deliver));
    assert.ok(replays.every((result) => result.status === 200 && result.body.duplicate === false));
    assert.equal(await db.payment.count({ where: { orderId: order.id } }), 1);
    assert.equal(await db.purchaseLicense.count({ where: { orderId: order.id } }), 1);
    const license = await db.purchaseLicense.findFirstOrThrow({ where: { orderId: order.id }, include: { downloadEntitlements: true } });
    assert.equal(license.downloadEntitlements.length, 1);
    assert.equal(license.revokedAt, null);

    // 3. The retried early refund now applies as a partial refund; rights remain.
    assert.equal((await deliver(early)).status, 200);
    let stored = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    assert.equal(stored.status, "PARTIALLY_REFUNDED");
    assert.equal(stored.payments[0]!.refundedCents, 4000);
    assert.equal((await db.purchaseLicense.findUniqueOrThrow({ where: { id: license.id } })).revokedAt, null);

    // 4. refund.updated / re-sent refund under a new event id is not double counted.
    const updated = refundEvent({ refundId: "re_early_" + suffix, paymentIntentId: intentId, amountCents: 4000, type: "refund.updated" });
    assert.equal((await deliver(updated)).status, 200);
    // 5. Tampered replay (same refund id, different amount) and over-refund are rejected and retryable.
    const tampered = refundEvent({ refundId: "re_early_" + suffix, paymentIntentId: intentId, amountCents: 5000 });
    const excessive = refundEvent({ refundId: "re_over_" + suffix, paymentIntentId: intentId, amountCents: 6001 });
    for (const event of [tampered, excessive]) {
      assert.equal((await deliver(event)).status, 500);
      assert.equal(await recorded(event.id), 0);
    }
    // 6. Non-succeeded refunds are acknowledged without effect.
    assert.equal((await deliver(refundEvent({ refundId: "re_pending_" + suffix, paymentIntentId: intentId, amountCents: 6000, status: "pending" }))).status, 200);
    const withRefunds = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { include: { refunds: true } } } });
    assert.equal(withRefunds.payments[0]!.refundedCents, 4000);
    assert.equal(withRefunds.payments[0]!.refunds.length, 1);

    // 7. The final refund fully refunds the order and revokes every right.
    assert.equal((await deliver(refundEvent({ refundId: "re_final_" + suffix, paymentIntentId: intentId, amountCents: 6000 }))).status, 200);
    stored = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    assert.equal(stored.status, "REFUNDED");
    assert.equal(stored.payments[0]!.status, "REFUNDED");
    assert.equal(stored.payments[0]!.refundedCents, 10000);
    const revoked = await db.purchaseLicense.findUniqueOrThrow({ where: { id: license.id } });
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revocationReason, "Order fully refunded.");
    await assert.rejects(requestDownloadPackage({ tenantId: tenant.id, customerId: license.customerId, purchaseLicenseId: license.id }));

    // 8. Late success events cannot restore revoked rights.
    assert.equal((await deliver(capture())).status, 200);
    const after = await db.purchaseLicense.findUniqueOrThrow({ where: { id: license.id } });
    assert.equal(after.revokedAt?.getTime(), revoked.revokedAt!.getTime());
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "REFUNDED");

    // 9. Refunds for another application's payment intent are ignored.
    mock.paymentIntents.set("pi_foreign_" + suffix, { metadata: {} });
    const foreign = refundEvent({ refundId: "re_foreign_" + suffix, paymentIntentId: "pi_foreign_" + suffix, amountCents: 100 });
    assert.equal((await deliver(foreign)).status, 200);
    assert.equal(await db.refund.count({ where: { providerRefundId: "re_foreign_" + suffix } }), 0);

    // 10. Signed events for another tenant's order metadata cannot fulfill this order.
    const crossTenant = checkoutCompleted({ id: eventId(), sessionId, orderId: order.id, tenantId: "another-tenant",
      paymentIntentId: intentId, amountCents: 10000, email: "x@example.test" });
    assert.equal((await deliver(crossTenant)).status, 500, "Mismatched tenant evidence is rejected before replay handling.");
    assert.equal(await recorded(crossTenant.id), 0);
    assert.equal(await db.purchaseLicense.count({ where: { orderId: order.id } }), 1);

    console.log("Stripe lifecycle (stripe-mock) validation passed: idempotent capture, out-of-order refund retry, partial/full refunds, replay/tamper/over-refund rejection, revocation durability, foreign intents.");
  } finally {
    await db.stripeWebhookEvent.deleteMany({ where: { providerEventId: { in: delivered } } });
    await db.order.deleteMany({ where: { tenantId: tenant.id } });
    await db.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    await mock.close();
    await db.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
