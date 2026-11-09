import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

import { ZipArchive } from "archiver";

import { db } from "@/lib/db";
import {
  getPrivateObject,
  uploadPrivateStream,
} from "@/lib/object-storage";
import {
  packageFileName,
  packageStorageKey,
  renderLicenseDocument,
  safeDownloadName,
} from "@/lib/download-delivery";
import { retryDelayMs, safeProcessingError } from "@/lib/processing-jobs";

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export async function requestDownloadPackage(input: {
  tenantId: string;
  customerId: string;
  purchaseLicenseId: string;
}) {
  const purchase = await db.purchaseLicense.findFirst({
    where: {
      id: input.purchaseLicenseId,
      tenantId: input.tenantId,
      customerId: input.customerId,
      revokedAt: null,
      order: {
        status: { in: ["PAID", "PARTIALLY_REFUNDED"] },
      },
    },
    include: {
      orderItem: { select: { workTitleSnapshot: true, licenseNameSnapshot: true } },
      downloadEntitlements: { select: { id: true } },
    },
  });

  if (!purchase) throw new Error("Purchased license is not available.");
  if (purchase.downloadEntitlements.length === 0) {
    throw new Error("This license has no downloadable source files.");
  }

  const existing = await db.downloadPackage.findUnique({
    where: { purchaseLicenseId: purchase.id },
  });

  if (existing && ["QUEUED", "PROCESSING", "READY"].includes(existing.status)) {
    return existing;
  }

  const fileName = packageFileName(
    purchase.orderItem.workTitleSnapshot,
    purchase.orderItem.licenseNameSnapshot,
  );

  if (existing) {
    return db.downloadPackage.update({
      where: { id: existing.id },
      data: {
        status: "QUEUED",
        fileName,
        storageKey: null,
        sizeBytes: null,
        checksumSha256: null,
        attempts: 0,
        runAfter: new Date(),
        lockedAt: null,
        lockedBy: null,
        startedAt: null,
        completedAt: null,
        lastError: null,
      },
    });
  }

  return db.downloadPackage.create({
    data: {
      tenantId: input.tenantId,
      purchaseLicenseId: purchase.id,
      fileName,
      status: "QUEUED",
    },
  });
}

export async function claimNextDownloadPackage(workerId: string) {
  const sql = [
    "WITH next_package AS (",
    '  SELECT "id"',
    '  FROM "DownloadPackage"',
    '  WHERE "status" = \'QUEUED\'::"DownloadPackageStatus"',
    '    AND "runAfter" <= NOW()',
    '    AND "attempts" < "maxAttempts"',
    '  ORDER BY "runAfter" ASC, "createdAt" ASC',
    "  FOR UPDATE SKIP LOCKED",
    "  LIMIT 1",
    ")",
    'UPDATE "DownloadPackage" AS package',
    'SET "status" = \'PROCESSING\'::"DownloadPackageStatus",',
    '    "attempts" = package."attempts" + 1,',
    '    "lockedAt" = NOW(),',
    '    "lockedBy" = $1,',
    '    "startedAt" = COALESCE(package."startedAt", NOW()),',
    '    "updatedAt" = NOW()',
    "FROM next_package",
    'WHERE package."id" = next_package."id"',
    'RETURNING package."id"',
  ].join("\n");

  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(sql, workerId);
  return rows[0]?.id ?? null;
}

export async function recoverStaleDownloadPackages(staleMinutes: number) {
  const cutoff = new Date(Date.now() - Math.max(1, staleMinutes) * 60_000);
  const stale = await db.downloadPackage.findMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    select: { id: true, attempts: true, maxAttempts: true },
  });

  let requeued = 0;
  let failed = 0;

  for (const entry of stale) {
    if (entry.attempts >= entry.maxAttempts) {
      await db.downloadPackage.update({
        where: { id: entry.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: "Worker lock expired after final package attempt.",
        },
      });
      failed += 1;
    } else {
      await db.downloadPackage.update({
        where: { id: entry.id },
        data: {
          status: "QUEUED",
          runAfter: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: "Recovered stale package worker lock.",
        },
      });
      requeued += 1;
    }
  }

  return { requeued, failed };
}

export async function buildDownloadPackage(packageId: string) {
  const record = await db.downloadPackage.findUnique({
    where: { id: packageId },
    include: {
      purchaseLicense: {
        include: {
          customer: { select: { email: true } },
          order: { select: { id: true, status: true } },
          orderItem: true,
          downloadEntitlements: {
            orderBy: { createdAt: "asc" },
            include: {
              audioAsset: {
                select: {
                  id: true,
                  status: true,
                  storageKey: true,
                  mimeType: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!record) throw new Error("Download package not found.");
  const purchase = record.purchaseLicense;

  if (
    purchase.revokedAt ||
    !["PAID", "PARTIALLY_REFUNDED"].includes(purchase.order.status)
  ) {
    throw new Error("Purchased license is no longer downloadable.");
  }

  const entries = purchase.downloadEntitlements.filter(
    (entry) =>
      entry.audioAsset.status === "READY" &&
      Boolean(entry.audioAsset.storageKey),
  );

  if (entries.length === 0) {
    throw new Error("No ready original files are available for this package.");
  }

  const storageKey = packageStorageKey({
    tenantId: record.tenantId,
    purchaseLicenseId: purchase.id,
    packageId: record.id,
  });

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const hash = createHash("sha256");
  let byteCount = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  archive.on("warning", (error) => {
    console.warn("Download package archive warning");
  });

  const uploadPromise = uploadPrivateStream({
    storageKey,
    body: meter,
    contentType: "application/zip",
  });

  archive.pipe(meter);

  const selectedStemLabels = stringArray(
    purchase.orderItem.selectedStemLabelsSnapshot,
  );

  archive.append(
    renderLicenseDocument({
      orderId: purchase.order.id,
      purchaseLicenseId: purchase.id,
      acceptedAt: purchase.acceptedAt,
      customerEmail: purchase.customer.email,
      workTitle: purchase.orderItem.workTitleSnapshot,
      licenseName: purchase.orderItem.licenseNameSnapshot,
      licenseVersionNumber: purchase.orderItem.licenseVersionNumber,
      priceCents: purchase.orderItem.unitPriceCents,
      currency: purchase.orderItem.currency,
      termsText: purchase.termsTextSnapshot,
      attributionRequired: purchase.orderItem.attributionRequired,
      commercialUseAllowed: purchase.orderItem.commercialUseAllowed,
      derivativesAllowed: purchase.orderItem.derivativesAllowed,
      redistributionAllowed: purchase.orderItem.redistributionAllowed,
      seatLimit: purchase.orderItem.seatLimit,
      projectLimit: purchase.orderItem.projectLimit,
      selectedStemLabels,
    }),
    { name: "LICENSE.txt" },
  );

  const usedNames = new Set<string>(["LICENSE.txt"]);

  for (let index = 0; index < entries.length; index += 1) {
    const entitlement = entries[index]!;
    const storageKeyForAsset = entitlement.audioAsset.storageKey;
    if (!storageKeyForAsset) continue;

    const object = await getPrivateObject(storageKeyForAsset);
    if (!object.Body || !(object.Body instanceof Readable)) {
      throw new Error("Object storage returned an unreadable source object.");
    }

    let name = safeDownloadName(
      entitlement.fileNameSnapshot,
      "source-" + String(index + 1),
    );
    if (usedNames.has(name)) {
      name = String(index + 1).padStart(2, "0") + " - " + name;
    }
    usedNames.add(name);

    archive.append(object.Body, { name });
  }

  await archive.finalize();
  await uploadPromise;

  await db.downloadPackage.update({
    where: { id: record.id },
    data: {
      status: "READY",
      storageKey,
      sizeBytes: BigInt(byteCount),
      checksumSha256: hash.digest("hex"),
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

export async function markDownloadPackageFailed(input: {
  packageId: string;
  attempts: number;
  maxAttempts: number;
  error: unknown;
}) {
  const message = safeProcessingError(input.error);
  const exhausted = input.attempts >= input.maxAttempts;

  if (exhausted) {
    await db.downloadPackage.update({
      where: { id: input.packageId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: message,
      },
    });
    return { exhausted: true, retryAt: null };
  }

  const retryAt = new Date(Date.now() + retryDelayMs(input.attempts));
  await db.downloadPackage.update({
    where: { id: input.packageId },
    data: {
      status: "QUEUED",
      runAfter: retryAt,
      lockedAt: null,
      lockedBy: null,
      lastError: message,
    },
  });

  return { exhausted: false, retryAt };
}
