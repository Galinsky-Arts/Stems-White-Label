import { publicOperationError } from "@/lib/public-operation-error";
import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { assertTenantStorageCapacity } from "@/lib/billing";
import {
  artworkStorageKey,
  validateArtworkUpload,
} from "@/lib/artwork";
import { db } from "@/lib/db";
import { createPrivateUploadUrl } from "@/lib/object-storage";

type RouteProps = { params: Promise<{ workId: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { workId } = await params;
  const work = await db.work.findFirst({
    where: { id: workId, tenantId: access.tenant.id, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  if (!work) return NextResponse.json({ error: "Work not found." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown }
    | null;

  try {
    const input = validateArtworkUpload({
      fileName: String(body?.fileName ?? ""),
      mimeType: String(body?.mimeType ?? ""),
      sizeBytes: Number(body?.sizeBytes),
    });

    const existing = await db.artworkAsset.findUnique({
      where: { workId },
      select: { id: true, sizeBytes: true },
    });
    const previousBytes = existing?.sizeBytes ?? 0n;
    const nextBytes = BigInt(input.sizeBytes);
    const additionalBytes = nextBytes > previousBytes ? nextBytes - previousBytes : 0n;
    await assertTenantStorageCapacity(access.tenant.id, additionalBytes);

    const assetId = existing?.id ?? randomUUID();

    const storageKey = artworkStorageKey({
      tenantId: access.tenant.id,
      workId,
      assetId,
      extension: input.extension,
    });

    const uploadUrl = await createPrivateUploadUrl({
      storageKey,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
    });

    const artwork = await db.artworkAsset.upsert({
      where: { workId },
      create: {
        id: assetId,
        tenantId: access.tenant.id,
        workId,
        status: "PENDING",
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        storageKey,
      },
      update: {
        status: "PENDING",
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        storageKey,
      },
      select: { id: true },
    });

    return NextResponse.json({
      assetId: artwork.id,
      uploadUrl,
      expiresInSeconds: 15 * 60,
      requiredHeaders: { "Content-Type": input.mimeType },
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to upload artwork.") },
      { status: 400 },
    );
  }
}
