import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { headPrivateObject } from "@/lib/object-storage";

type CompleteRouteProps = {
  params: Promise<{ assetId: string }>;
};

export async function POST(_request: Request, { params }: CompleteRouteProps) {
  const access = await getTenantApiAccess("catalog.write");

  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { assetId } = await params;
  const asset = await db.audioAsset.findFirst({
    where: {
      id: assetId,
      tenantId: access.tenant.id,
      kind: { in: ["MASTER", "STEM"] },
    },
    select: {
      id: true,
      workId: true,
      status: true,
      storageKey: true,
      sizeBytes: true,
      mimeType: true,
    },
  });

  if (!asset?.storageKey) {
    return NextResponse.json({ error: "Source asset not found." }, { status: 404 });
  }

  const existingJob = await db.processingJob.findUnique({
    where: {
      audioAssetId_type: {
        audioAssetId: asset.id,
        type: "PROCESS_AUDIO",
      },
    },
  });

  if (asset.status === "READY" || existingJob?.status === "SUCCEEDED") {
    return NextResponse.json({
      assetId: asset.id,
      status: "READY",
      job: existingJob,
    });
  }

  if (
    existingJob?.status === "QUEUED" ||
    existingJob?.status === "RUNNING"
  ) {
    return NextResponse.json(
      {
        assetId: asset.id,
        status: "PROCESSING",
        job: {
          id: existingJob.id,
          status: existingJob.status,
          attempts: existingJob.attempts,
          maxAttempts: existingJob.maxAttempts,
        },
      },
      { status: 202 },
    );
  }

  let stored;

  try {
    stored = await headPrivateObject(asset.storageKey);
  } catch (error) {
    console.error("Unable to verify uploaded source object");
    return NextResponse.json(
      { error: "Uploaded object could not be verified." },
      { status: 409 },
    );
  }

  const storedBytes = stored.ContentLength;

  if (
    asset.sizeBytes !== null &&
    (storedBytes === undefined || BigInt(storedBytes) !== asset.sizeBytes)
  ) {
    return NextResponse.json(
      {
        error: "Uploaded object size does not match the declared source size.",
        expectedBytes: asset.sizeBytes.toString(),
        storedBytes: storedBytes?.toString() ?? null,
      },
      { status: 409 },
    );
  }

  const job = await db.$transaction(async (tx) => {
    await tx.audioAsset.update({
      where: { id: asset.id },
      data: {
        status: "PROCESSING",
        mimeType: stored.ContentType || asset.mimeType,
        sizeBytes:
          storedBytes === undefined ? asset.sizeBytes : BigInt(storedBytes),
      },
    });

    await tx.work.updateMany({
      where: {
        id: asset.workId,
        tenantId: access.tenant.id,
        status: { in: ["DRAFT", "READY"] },
      },
      data: { status: "PROCESSING" },
    });

    return tx.processingJob.upsert({
      where: {
        audioAssetId_type: {
          audioAssetId: asset.id,
          type: "PROCESS_AUDIO",
        },
      },
      create: {
        tenantId: access.tenant.id,
        audioAssetId: asset.id,
        type: "PROCESS_AUDIO",
        status: "QUEUED",
      },
      update: {
        status: "QUEUED",
        attempts: 0,
        runAfter: new Date(),
        lockedAt: null,
        lockedBy: null,
        startedAt: null,
        completedAt: null,
        lastError: null,
      },
    });
  });

  return NextResponse.json(
    {
      assetId: asset.id,
      status: "PROCESSING",
      job: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      },
    },
    { status: 202 },
  );
}
