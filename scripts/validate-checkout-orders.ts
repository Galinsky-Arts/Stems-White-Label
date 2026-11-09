import { validateSecurityHttp } from "./validate-security-http";
import { validateWebhookSecurity } from "./validate-webhook-security";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { POST as paymentWebhook } from "../src/app/api/stripe/webhook/route";

import { processStripeWebhookOnce } from "../src/lib/stripe-webhook";
import { db } from "../src/lib/db";
import { createPendingOrder, quoteLicenseProducts } from "../src/lib/checkout";
import { markOrderPaid, markOrderPaymentFailed, recordRefund } from "../src/lib/payments";

async function main() {
  const suffix = Date.now().toString(36);
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_security_fixture";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_offline_security_fixture";
  const signedEventIds: string[] = [];
  async function deliver(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return paymentWebhook(new Request("https://store.example/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }));
  }
  const tenant = await db.tenant.create({
    data: { name: "Checkout Validation " + suffix, slug: "checkout-validation-" + suffix },
  });

  try {
    const work = await db.work.create({
      data: {
        tenantId: tenant.id,
        slug: "checkout-work-" + suffix,
        title: "Checkout Work",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });
    const stem = await db.stemGroup.create({
      data: { workId: work.id, slug: "horns", label: "Horn Section" },
    });
    const sourceAsset = await db.audioAsset.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        stemGroupId: stem.id,
        kind: "STEM",
        status: "READY",
        fileName: "horn-section.wav",
        storageKey: "validation/" + suffix + "/horn-section.wav",
        mimeType: "audio/wav",
        sizeBytes: BigInt(1024),
      },
    });

    const product = await db.licenseProduct.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        slug: "commercial",
        name: "Commercial",
        scope: "SELECTED_STEMS",
        selectedStems: { create: [{ stemGroupId: stem.id }] },
        versions: {
          create: {
            version: 1,
            priceCents: 12500,
            currency: "USD",
            termsText: "Immutable checkout terms.",
          },
        },
      },
    });

    const quote = await quoteLicenseProducts(tenant.id, [product.id]);
    assert.equal(quote.subtotalCents, 12500);
    assert.deepEqual(quote.items[0]?.selectedStemLabels, ["Horn Section"]);
    assert.deepEqual(
      quote.items[0]?.deliverableAssets.map((asset) => asset.id),
      [sourceAsset.id],
    );

    const order = await createPendingOrder(
      tenant.id,
      quote,
      true,
      "buyer@example.com",
      {
        stripeConnectedAccountId: "acct_checkout_validation",
        platformFeeCents: 625,
      },
    );
    assert.equal(order.status, "PENDING");
    assert.equal(order.items[0]?.termsTextSnapshot, "Immutable checkout terms.");
    assert.equal(order.stripeConnectedAccountId, "acct_checkout_validation");
    assert.equal(order.platformFeeCents, 625);
    assert.equal(order.payments[0]?.status, "PENDING");
    assert.equal(order.payments[0]?.stripeConnectedAccountId, "acct_checkout_validation");
    assert.equal(order.payments[0]?.platformFeeCents, 625);

    await db.licenseVersion.update({
      where: { id: quote.items[0]!.licenseVersionId },
      data: { retiredAt: new Date() },
    });
    await db.licenseVersion.create({
      data: {
        licenseProductId: product.id,
        version: 2,
        priceCents: 15000,
        currency: "USD",
        termsText: "New terms.",
      },
    });

    const stored = await db.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
      include: { deliverableAssets: true },
    });
    assert.equal(stored.unitPriceCents, 12500);
    assert.equal(stored.deliverableAssets[0]?.audioAssetId, sourceAsset.id);
    assert.equal(stored.termsTextSnapshot, "Immutable checkout terms.");

    await db.order.update({ where: { id: order.id }, data: { stripeCheckoutSessionId: "cs_" + suffix } });
    const paymentEvidence = { sessionId: "cs_" + suffix, tenantId: tenant.id, amountTotal: 12500, currency: "usd", mode: "payment", paymentStatus: "paid" };
    for (const mismatch of [{ tenantId: "another-tenant" }, { amountTotal: 1 }, { currency: "eur" }, { sessionId: "cs_other" }]) {
      await assert.rejects(markOrderPaid({ orderId: order.id, email: "buyer@example.com", checkoutEvidence: { ...paymentEvidence, ...mismatch } }));
    }
    assert.equal(await db.customer.count({ where: { tenantId: tenant.id } }), 0);
    assert.equal(await db.purchaseLicense.count({ where: { orderId: order.id } }), 0);

    const signedEventId = "evt_signed_" + suffix;
    signedEventIds.push(signedEventId);
    const session = {
      id: paymentEvidence.sessionId, mode: "payment", payment_status: "paid",
      currency: "usd", amount_total: 12500, customer: "cus_validation",
      customer_details: { email: "buyer@example.com", name: "Buyer" },
      payment_intent: "pi_" + suffix, metadata: { orderId: order.id, tenantId: tenant.id },
    };
    const signed = { id: signedEventId, type: "checkout.session.completed", data: { object: session } };
    const mismatched = await deliver({ ...signed, data: { object: { ...session, amount_total: 1 } } });
    assert.equal(mismatched.status, 500);
    assert.deepEqual(await mismatched.json(), { error: "Webhook processing failed." });
    assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: signedEventId } }), 0);
    const signedResults = await Promise.all(Array.from({ length: 4 }, () => deliver(signed)));
    const signedBodies = await Promise.all(signedResults.map((response) => response.json()));
    assert.ok(signedResults.every((response) => response.status === 200));
    assert.equal(signedBodies.filter((body) => body.duplicate === false).length, 1);

    const paid = await markOrderPaid({
      orderId: order.id,
      email: "Buyer@Example.com",
      stripeCustomerId: "cus_validation",
      stripePaymentIntentId: "pi_" + suffix,
      checkoutEvidence: paymentEvidence,
    });
    assert.equal(paid.status, "PAID");
    assert.equal(paid.customer?.normalizedEmail, "buyer@example.com");
    assert.equal(paid.items[0]?.purchaseLicense?.licenseVersionId, stored.licenseVersionId);

    const concurrentPaid = await Promise.all(Array.from({ length: 4 }, () => markOrderPaid({
      orderId: order.id,
      email: "Buyer@Example.com",
      stripeCustomerId: "cus_validation",
      stripePaymentIntentId: "pi_" + suffix,
      checkoutEvidence: paymentEvidence,
    })));
    const paidAgain = concurrentPaid[0]!;
    const grants = await db.purchaseLicense.count({ where: { orderId: order.id } });
    const entitlements = await db.downloadEntitlement.findMany({
      where: { purchaseLicense: { orderId: order.id } },
    });
    assert.equal(paidAgain.status, "PAID");
    assert.equal(grants, 1);
    assert.equal(entitlements.length, 1);
    assert.equal(entitlements[0]?.audioAssetId, sourceAsset.id);

    const partial = await recordRefund({
      orderId: order.id,
      providerRefundId: "re_partial_" + suffix,
      amountCents: 2500,
    });
    assert.equal(partial.status, "PARTIALLY_REFUNDED");

    // Success/failure replays cannot erase a partial refund or transfer ownership.
    await markOrderPaid({ orderId: order.id, email: "buyer@example.com", stripePaymentIntentId: "pi_" + suffix });
    await markOrderPaymentFailed({ orderId: order.id, stripePaymentIntentId: "pi_" + suffix });
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "PARTIALLY_REFUNDED");
    await assert.rejects(markOrderPaid({ orderId: order.id, email: "attacker@example.com", stripePaymentIntentId: "pi_" + suffix }));
    await assert.rejects(recordRefund({ orderId: order.id, providerRefundId: "re_partial_" + suffix, amountCents: 1 }));
    await assert.rejects(recordRefund({ orderId: order.id, providerRefundId: "re_over_" + suffix, amountCents: 12500 }));

    const fullyRefunded = await recordRefund({
      orderId: order.id,
      providerRefundId: "re_final_" + suffix,
      amountCents: 10000,
    });
    assert.equal(fullyRefunded.status, "REFUNDED");
    assert.equal(fullyRefunded.payments[0]?.refundedCents, 12500);
    const revoked = await db.purchaseLicense.findFirstOrThrow({
      where: { orderId: order.id },
    });
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revocationReason, "Order fully refunded.");

    const lateSuccessId = "evt_late_success_" + suffix;
    signedEventIds.push(lateSuccessId);
    assert.equal((await deliver({ ...signed, id: lateSuccessId })).status, 200);
    const revokedAt = revoked.revokedAt!.getTime();
    await Promise.all([
      markOrderPaid({ orderId: order.id, email: "buyer@example.com", stripePaymentIntentId: "pi_" + suffix }),
      recordRefund({ orderId: order.id, providerRefundId: "re_final_" + suffix, amountCents: 10000 }),
    ]);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status, "REFUNDED");
    assert.equal((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status, "REFUNDED");
    assert.equal((await db.purchaseLicense.findFirstOrThrow({ where: { orderId: order.id } })).revokedAt!.getTime(), revokedAt);
    assert.equal(await db.customer.count({ where: { tenantId: tenant.id } }), 1);

    const eventId = "evt_security_" + suffix;
    try {
      // A handler failure must roll back effects AND leave the event retryable.
      await assert.rejects(processStripeWebhookOnce("PAYMENTS", { id: eventId, type: "security.test" }, async (tx) => {
        await tx.tenant.update({ where: { id: tenant.id }, data: { name: "Must roll back" } });
        throw new Error("Injected handler failure");
      }));
      assert.notEqual((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).name, "Must roll back");
      assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: eventId } }), 0);
      const results = await Promise.all(Array.from({ length: 4 }, () => processStripeWebhookOnce("PAYMENTS", { id: eventId, type: "security.test" }, async (tx) => {
        await tx.tenant.update({ where: { id: tenant.id }, data: { name: "Once only" } });
      })));
      assert.equal(results.filter((result) => !result.duplicate).length, 1);
      assert.equal(await db.stripeWebhookEvent.count({ where: { providerEventId: eventId } }), 1);
    } finally {
      await db.stripeWebhookEvent.deleteMany({ where: { providerEventId: eventId } });
    }
    await validateWebhookSecurity(suffix);
    await validateSecurityHttp(suffix);
    console.log("Checkout/order database integration validation passed, including signed payments/billing/connect replay/concurrency/rollback security cases.");
  } finally {
    await db.stripeWebhookEvent.deleteMany({ where: { providerEventId: { in: signedEventIds } } });
    await db.order.deleteMany({ where: { tenantId: tenant.id } });
    await db.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
