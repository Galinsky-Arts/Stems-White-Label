import { publicOperationError } from "@/lib/public-operation-error";
import { randomUUID } from "node:crypto";

import type { ThemeAssetKind } from "@prisma/client";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  assertTenantCanUseWhiteLabel,
  assertTenantStorageCapacity,
} from "@/lib/billing";
import { db } from "@/lib/db";
import { createPrivateUploadUrl } from "@/lib/object-storage";
import {
  themeAssetStorageKey,
  validateThemeAssetUpload,
} from "@/lib/theme-assets";

export async function POST(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { kind?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown }
    | null;

  try {
    const kind = String(body?.kind ?? "") as ThemeAssetKind;
    if (kind !== "LOGO" && kind !== "FAVICON") {
      throw new Error("Brand asset kind must be LOGO or FAVICON.");
    }

    const input = validateThemeAssetUpload({
      kind,
      fileName: String(body?.fileName ?? ""),
      mimeType: String(body?.mimeType ?? ""),
      sizeBytes: Number(body?.sizeBytes),
    });

    await assertTenantCanUseWhiteLabel(access.tenant.id);
    await assertTenantStorageCapacity(access.tenant.id, input.sizeBytes);

    const assetId = randomUUID();
    const storageKey = themeAssetStorageKey({
      tenantId: access.tenant.id,
      assetId,
      kind,
      extension: input.extension,
    });

    const uploadUrl = await createPrivateUploadUrl({
      storageKey,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
    });

    await db.themeAsset.create({
      data: {
        id: assetId,
        tenantId: access.tenant.id,
        kind,
        status: "PENDING",
        fileName: input.fileName,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
      },
    });

    return NextResponse.json({
      assetId,
      uploadUrl,
      requiredHeaders: { "Content-Type": input.mimeType },
      expiresInSeconds: 15 * 60,
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to start brand upload.") },
      { status: 400 },
    );
  }
}
