import { validateOperations } from "./validate-operations";
import assert from "node:assert/strict";

import {
  removeTenantFeatureFlag,
  retryFailedDownloadPackage,
  retryFailedProcessingJob,
  setTenantFeatureFlag,
  updatePlatformTenantStatus,
  updateTenantPlatformFee,
} from "../src/lib/platform-admin";
import { db } from "../src/lib/db";

async function main() {
  const suffix = Date.now().toString(36);
  const actor = await db.user.create({
    data: {
      email: "platform-admin-" + suffix + "@example.test",
      platformRole: "SUPER_ADMIN",
    },
  });

  const tenant = await db.tenant.create({
    data: {
      name: "Platform Admin Validation " + suffix,
      slug: "platform-admin-validation-" + suffix,
    },
  });

  try {
    const platformActor = { id: actor.id, email: actor.email };

    const suspended = await updatePlatformTenantStatus({
      actor: platformActor,
      tenantId: tenant.id,
      status: "SUSPENDED",
      reason: "Validation of tenant suspension audit behavior.",
    });
    assert.equal(suspended.status, "SUSPENDED");

    const reactivated = await updatePlatformTenantStatus({
      actor: platformActor,
      tenantId: tenant.id,
      status: "ACTIVE",
      reason: "Validation of tenant reactivation audit behavior.",
    });
    assert.equal(reactivated.status, "ACTIVE");

    const commerce = await updateTenantPlatformFee({
      actor: platformActor,
      tenantId: tenant.id,
      platformFeeBps: 625,
      reason: "Validation of platform fee override audit behavior.",
    });
    assert.equal(commerce.platformFeeBps, 625);

    const flag = await setTenantFeatureFlag({
      actor: platformActor,
      tenantId: tenant.id,
      key: "beta.reveal_v2",
      enabled: true,
      note: "Validation rollout",
      reason: "Validation of tenant feature-flag rollout behavior.",
    });
    assert.equal(flag.enabled, true);
    assert.equal(flag.key, "beta.reveal_v2");

    await removeTenantFeatureFlag({
      actor: platformActor,
      tenantId: tenant.id,
      key: flag.key,
      reason: "Validation of feature-flag removal audit behavior.",
    });
    assert.equal(
      await db.tenantFeatureFlag.count({ where: { tenantId: tenant.id } }),
      0,
    );

    const work = await db.work.create({
      data: {
        tenantId: tenant.id,
        slug: "platform-job-" + suffix,
        title: "Platform Job Validation",
        status: "DRAFT",
      },
    });

    const asset = await db.audioAsset.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        kind: "MASTER",
        status: "FAILED",
        fileName: "failed.wav",
      },
    });

    const processingJob = await db.processingJob.create({
      data: {
        tenantId: tenant.id,
        audioAssetId: asset.id,
        status: "FAILED",
        attempts: 3,
        maxAttempts: 3,
        completedAt: new Date(),
        lastError: "Validation failure.",
      },
    });

    const retried = await retryFailedProcessingJob({
      actor: platformActor,
      tenantId: tenant.id,
      jobId: processingJob.id,
      reason: "Validation of failed processing-job operator retry.",
    });
    assert.equal(retried.status, "QUEUED");
    assert.equal(retried.attempts, 0);

    const [retriedAsset, retriedWork] = await Promise.all([
      db.audioAsset.findUniqueOrThrow({ where: { id: asset.id } }),
      db.work.findUniqueOrThrow({ where: { id: work.id } }),
    ]);
    assert.equal(retriedAsset.status, "PROCESSING");
    assert.equal(retriedWork.status, "PROCESSING");

    const customer = await db.customer.create({
      data: {
        tenantId: tenant.id,
        email: "customer-" + suffix + "@example.test",
        normalizedEmail: "customer-" + suffix + "@example.test",
      },
    });
    const product = await db.licenseProduct.create({
      data: {
        tenantId: tenant.id,
        workId: work.id,
        slug: "license-" + suffix,
        name: "Validation License",
      },
    });
    const version = await db.licenseVersion.create({
      data: {
        licenseProductId: product.id,
        version: 1,
        priceCents: 1000,
        currency: "USD",
        termsText: "Validation terms.",
      },
    });
    const order = await db.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "PAID",
        currency: "USD",
        subtotalCents: 1000,
        totalCents: 1000,
        buyerEmail: customer.email,
        termsAcceptedAt: new Date(),
        paidAt: new Date(),
      },
    });
    const item = await db.orderItem.create({
      data: {
        orderId: order.id,
        licenseProductId: product.id,
        licenseVersionId: version.id,
        workId: work.id,
        licenseNameSnapshot: product.name,
        workTitleSnapshot: work.title,
        licenseVersionNumber: 1,
        scopeSnapshot: "ALL_STEMS",
        unitPriceCents: 1000,
        currency: "USD",
        termsTextSnapshot: version.termsText,
        attributionRequired: false,
        commercialUseAllowed: true,
        derivativesAllowed: true,
        redistributionAllowed: false,
      },
    });
    const purchase = await db.purchaseLicense.create({
      data: {
        tenantId: tenant.id,
        orderId: order.id,
        orderItemId: item.id,
        customerId: customer.id,
        licenseVersionId: version.id,
        acceptedAt: new Date(),
        termsTextSnapshot: version.termsText,
      },
    });
    const downloadPackage = await db.downloadPackage.create({
      data: {
        tenantId: tenant.id,
        purchaseLicenseId: purchase.id,
        status: "FAILED",
        fileName: "package.zip",
        attempts: 3,
        maxAttempts: 3,
        completedAt: new Date(),
        lastError: "Validation package failure.",
      },
    });

    const retriedPackage = await retryFailedDownloadPackage({
      actor: platformActor,
      tenantId: tenant.id,
      packageId: downloadPackage.id,
      reason: "Validation of failed package operator retry behavior.",
    });
    assert.equal(retriedPackage.status, "QUEUED");
    assert.equal(retriedPackage.attempts, 0);

    // CI reuses the same PostgreSQL database across integration gates. Audit
    // retention intentionally keeps this tenant alive, so return these fixtures
    // to inert failed states after proving the retry transition. Otherwise a
    // later global worker test can legitimately claim these older queued rows.
    await db.$transaction([
      db.processingJob.update({
        where: { id: processingJob.id },
        data: {
          status: "FAILED",
          attempts: 3,
          completedAt: new Date(),
          lastError: "Validation cleanup after retry assertion.",
        },
      }),
      db.audioAsset.update({
        where: { id: asset.id },
        data: { status: "FAILED" },
      }),
      db.work.update({
        where: { id: work.id },
        data: { status: "DRAFT" },
      }),
      db.downloadPackage.update({
        where: { id: downloadPackage.id },
        data: {
          status: "FAILED",
          attempts: 3,
          completedAt: new Date(),
          lastError: "Validation cleanup after retry assertion.",
        },
      }),
    ]);

    const auditRows = await db.platformAuditLog.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(auditRows.length, 7);
    assert.deepEqual(
      auditRows.map((row) => row.action),
      [
        "TENANT_SUSPENDED",
        "TENANT_REACTIVATED",
        "PLATFORM_FEE_UPDATED",
        "FEATURE_FLAG_SET",
        "FEATURE_FLAG_REMOVED",
        "PROCESSING_JOB_RETRIED",
        "DOWNLOAD_PACKAGE_RETRIED",
      ],
    );

    await assert.rejects(() =>
      db.platformAuditLog.update({
        where: { id: auditRows[0]!.id },
        data: { reason: "Attempted mutation should fail." },
      }),
    );
    await assert.rejects(() =>
      db.platformAuditLog.delete({
        where: { id: auditRows[0]!.id },
      }),
    );

    await validateOperations();
    console.log("Platform super-admin database integration validation passed.");
  } finally {
    // The audit ledger intentionally RESTRICTs deletion of referenced actors and
    // tenants. CI uses an ephemeral database, so validation rows are left intact.
    await db.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exitCode = 1;
});
