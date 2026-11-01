import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { headPrivateObject } from "@/lib/object-storage";

type RouteProps = { params: Promise<{ assetId: string }> };

export async function POST(_request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { assetId } = await params;
  const asset = await db.artworkAsset.findFirst({
    where: { id: assetId, tenantId: access.tenant.id },
  });

  if (!asset?.storageKey) {
    return NextResponse.json({ error: "Artwork not found." }, { status: 404 });
  }

  try {
    const stored = await headPrivateObject(asset.storageKey);
    if (
      stored.ContentLength === undefined ||
      BigInt(stored.ContentLength) !== asset.sizeBytes
    ) {
      return NextResponse.json(
        { error: "Uploaded artwork size does not match the declared size." },
        { status: 409 },
      );
    }

    const updated = await db.artworkAsset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        mimeType: stored.ContentType || asset.mimeType,
      },
      select: { id: true, status: true },
    });

    return NextResponse.json({ artwork: updated });
  } catch (error) {
    console.error("Unable to verify artwork");
    return NextResponse.json(
      { error: "Uploaded artwork could not be verified." },
      { status: 409 },
    );
  }
}
