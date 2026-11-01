import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { assertTenantStorageCapacity } from "@/lib/billing";
import {
  sourceStorageKey,
  validateSourceUpload,
} from "@/lib/asset-upload";
import { db } from "@/lib/db";
import { createPrivateUploadUrl } from "@/lib/object-storage";

type UploadIntentRouteProps = {
  params: Promise<{ workId: string }>;
};

export async function POST(request: Request, { params }: UploadIntentRouteProps) {
  const access = await getTenantApiAccess("catalog.write");

  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { workId } = await params;
  const work = await db.work.findFirst({
    where: {
      id: workId,
      tenantId: access.tenant.id,
      status: { not: "ARCHIVED" },
    },
    select: { id: true },
  });

  if (!work) {
    return NextResponse.json({ error: "Work not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        fileName?: unknown;
        mimeType?: unknown;
        sizeBytes?: unknown;
        kind?: unknown;
        stemGroupId?: unknown;
        label?: unknown;
      }
    | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let upload;

  try {
    upload = validateSourceUpload({
      fileName: String(body.fileName ?? ""),
      mimeType: String(body.mimeType ?? ""),
      sizeBytes: Number(body.sizeBytes),
      kind: String(body.kind ?? ""),
      stemGroupId:
        typeof body.stemGroupId === "string" ? body.stemGroupId : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          publicOperationError(error, "Invalid source upload."),
      },
      { status: 400 },
    );
  }

  try {
    await assertTenantStorageCapacity(access.tenant.id, upload.sizeBytes);
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Storage limit reached.") },
      { status: 403 },
    );
  }

  if (upload.stemGroupId) {
    const stem = await db.stemGroup.findFirst({
      where: {
        id: upload.stemGroupId,
        workId,
        work: { tenantId: access.tenant.id },
      },
      select: { id: true },
    });

    if (!stem) {
      return NextResponse.json(
        { error: "StemGroup does not belong to this Work." },
        { status: 400 },
      );
    }
  }

  const asset = await db.audioAsset.create({
    data: {
      tenantId: access.tenant.id,
      workId,
      stemGroupId: upload.stemGroupId,
      kind: upload.kind,
      status: "PENDING",
      label:
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim().slice(0, 180)
          : null,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: BigInt(upload.sizeBytes),
    },
    select: { id: true },
  });

  const storageKey = sourceStorageKey({
    tenantId: access.tenant.id,
    workId,
    assetId: asset.id,
    fileName: upload.fileName,
  });

  try {
    const uploadUrl = await createPrivateUploadUrl({
      storageKey,
      contentType: upload.mimeType,
      contentLength: upload.sizeBytes,
    });

    await db.audioAsset.update({
      where: { id: asset.id },
      data: { storageKey },
    });

    return NextResponse.json(
      {
        assetId: asset.id,
        uploadUrl,
        expiresInSeconds: 15 * 60,
        requiredHeaders: {
          "Content-Type": upload.mimeType,
        },
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    await db.audioAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    console.error("Unable to create source upload URL");

    return NextResponse.json(
      { error: "Object storage is not configured or unavailable." },
      { status: 503 },
    );
  }
}
