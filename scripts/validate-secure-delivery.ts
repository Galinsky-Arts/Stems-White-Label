import assert from "node:assert/strict";

import { resolveCustomerForIdentity } from "../src/lib/customer-identity";
import { db } from "../src/lib/db";
import { createPendingOrder, quoteLicenseProducts } from "../src/lib/checkout";
import {
  claimNextDownloadPackage,
  markDownloadPackageFailed,
  requestDownloadPackage,
} from "../src/lib/download-packages";
import { markOrderPaid } from "../src/lib/payments";

async function main() {
  const suffix = Date.now().toString(36);
  const tenant = await db.tenant.create({
    data: { name: "Delivery Validation " + suffix, slug: "delivery-validation-" + suffix },
  });

  const otherTenant = await db.tenant.create({ data: { name: "Other delivery tenant", slug: "delivery-other-" + suffix } });
  const users = await Promise.all([
    db.user.create({ data: { email: "delivery@example.com" } }),
    db.user.create({ data: { email: "other-" + suffix + "@example.com", emailVerified: new Date() } }),
  ]);
  try {
    const work = await db.work.create({
      data: {
        tenantId: tenant.id,
        slug: "delivery-work-" + suffix,
        title: "Delivery Work",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });
    const stem = await db.stemGroup.create({
      data: { workId: work.id, slug: "section", label: "Section" },
    });
    const asset = await db.audioAsset.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        stemGroupId: stem.id,
        kind: "STEM",
        status: "READY",
        fileName: "section.wav",
        storageKey: "validation/" + suffix + "/section.wav",
        mimeType: "audio/wav",
        sizeBytes: BigInt(2048),
      },
    });
    const product = await db.licenseProduct.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        slug: "all-source",
        name: "All Source",
        scope: "ALL_STEMS",
        versions: {
          create: {
            version: 1,
            priceCents: 9900,
            currency: "USD",
            termsText: "Delivery validation terms.",
          },
        },
      },
    });

    const quote = await quoteLicenseProducts(tenant.id, [product.id]);
    const order = await createPendingOrder(
      tenant.id,
      quote,
      true,
      "delivery@example.com",
    );
    const paid = await markOrderPaid({
      orderId: order.id,
      email: "delivery@example.com",
      stripePaymentIntentId: "pi_delivery_" + suffix,
    });
    const customer = paid.customer!;
    const purchase = await db.purchaseLicense.findFirstOrThrow({
      where: { orderId: order.id },
      include: { downloadEntitlements: true },
    });

    assert.equal(purchase.downloadEntitlements.length, 1);
    assert.equal(purchase.downloadEntitlements[0]?.audioAssetId, asset.id);

    // Automatic purchase linking requires verified email and the correct tenant.
    assert.equal(await resolveCustomerForIdentity(tenant.id, users[0]!.id), null);
    assert.equal(await resolveCustomerForIdentity(tenant.id, users[1]!.id), null);
    await db.user.update({ where: { id: users[0]!.id }, data: { emailVerified: new Date() } });
    assert.equal(await resolveCustomerForIdentity(otherTenant.id, users[0]!.id), null);
    const linked = await Promise.all(Array.from({ length: 3 }, () => resolveCustomerForIdentity(tenant.id, users[0]!.id)));
    assert.ok(linked.every((entry) => entry?.id === customer.id));
    // A customer explicitly linked to another principal cannot be reassigned by email.
    await db.customer.update({ where: { id: customer.id }, data: { userId: users[1]!.id } });
    assert.equal(await resolveCustomerForIdentity(tenant.id, users[0]!.id), null);
    assert.equal((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).userId, users[1]!.id);
    await db.customer.update({ where: { id: customer.id }, data: { userId: users[0]!.id } });

    await assert.rejects(requestDownloadPackage({ tenantId: otherTenant.id, customerId: customer.id, purchaseLicenseId: purchase.id }));
    await assert.rejects(requestDownloadPackage({ tenantId: tenant.id, customerId: "wrong-customer", purchaseLicenseId: purchase.id }));
    const queued = await requestDownloadPackage({
      tenantId: tenant.id,
      customerId: customer.id,
      purchaseLicenseId: purchase.id,
    });
    assert.equal(queued.status, "QUEUED");

    const claimedId = await claimNextDownloadPackage("delivery-validation-worker");
    assert.equal(claimedId, queued.id);

    const claimed = await db.downloadPackage.findUniqueOrThrow({
      where: { id: queued.id },
    });
    assert.equal(claimed.status, "PROCESSING");
    assert.equal(claimed.attempts, 1);

    const retry = await markDownloadPackageFailed({
      packageId: claimed.id,
      attempts: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
      error: new Error("provider diagnostic secret-token customer@example.com"),
    });
    assert.equal(retry.exhausted, false);

    const requeued = await db.downloadPackage.findUniqueOrThrow({
      where: { id: queued.id },
    });
    assert.equal(requeued.status, "QUEUED");
    assert.equal(requeued.lastError, "Processing failed. Inspect the job state and retry safely.");
    assert.doesNotMatch(requeued.lastError ?? "", /secret-token|customer@/);

    console.log("Secure delivery database integration validation passed.");
  } finally {
    await db.order.deleteMany({ where: { tenantId: tenant.id } });
    await db.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    await db.tenant.delete({ where: { id: otherTenant.id } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await db.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
