import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { headPrivateObject } from "@/lib/object-storage";

type RouteProps = { params: Promise<{ assetId: string }> };

export async function POST(_request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { assetId } = await params;
  const asset = await db.themeAsset.findFirst({
    where: { id: assetId, tenantId: access.tenant.id, status: "PENDING" },
  });
  if (!asset?.storageKey) {
    return NextResponse.json({ error: "Brand asset not found." }, { status: 404 });
  }

  try {
    const object = await headPrivateObject(asset.storageKey);
    if (object.ContentLength !== Number(asset.sizeBytes)) {
      throw new Error("Uploaded brand asset size does not match the declared file.");
    }
    if (
      object.ContentType &&
      object.ContentType.toLowerCase() !== asset.mimeType.toLowerCase()
    ) {
      throw new Error("Uploaded brand asset MIME type does not match.");
    }

    await db.$transaction(async (tx) => {
      await tx.themeAsset.update({
        where: { id: asset.id },
        data: { status: "READY" },
      });

      await tx.tenantTheme.upsert({
        where: { tenantId: access.tenant.id },
        create: {
          tenantId: access.tenant.id,
          ...(asset.kind === "LOGO"
            ? { logoAssetId: asset.id }
            : { faviconAssetId: asset.id }),
        },
        update:
          asset.kind === "LOGO"
            ? { logoAssetId: asset.id }
            : { faviconAssetId: asset.id },
      });
    });

    return NextResponse.json({
      assetId: asset.id,
      kind: asset.kind,
      status: "READY",
      publicUrl: asset.kind === "LOGO" ? "/api/theme/logo" : "/api/theme/favicon",
    });
  } catch (error) {
    await db.themeAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED" },
    }).catch(() => undefined);

    return NextResponse.json(
      { error: publicOperationError(error, "Unable to verify brand asset.") },
      { status: 400 },
    );
  }
}
