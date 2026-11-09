import { NextResponse } from "next/server";

import { verifyArtworkAccess } from "@/lib/artwork";
import { db } from "@/lib/db";
import { getPrivateObject } from "@/lib/object-storage";
import { getTenantApiAccess } from "@/lib/access";
import { getCurrentTenant } from "@/lib/tenant";

export const runtime = "nodejs";

type RouteProps = { params: Promise<{ assetId: string }> };

export async function GET(request: Request, { params }: RouteProps) {
  const { assetId } = await params;
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";

  if (!verifyArtworkAccess(assetId, expires, signature)) {
    return NextResponse.json({ error: "Artwork link expired or invalid." }, { status: 403 });
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: "Storefront not found." }, { status: 404 });

  const asset = await db.artworkAsset.findFirst({
    where: {
      id: assetId,
      tenantId: tenant.id,
      status: "READY",
      storageKey: { not: null },
    },
    select: {
      storageKey: true,
      mimeType: true,
      work: { select: { status: true } },
    },
  });

  if (!asset?.storageKey) {
    return NextResponse.json({ error: "Artwork not found." }, { status: 404 });
  }

  if (asset.work.status !== "PUBLISHED") {
    const access = await getTenantApiAccess("catalog.read");
    if (!access || access.tenant.id !== tenant.id) {
      return NextResponse.json({ error: "Artwork not found." }, { status: 404 });
    }
  }

  try {
    const object = await getPrivateObject(asset.storageKey);
    if (!object.Body) {
      return NextResponse.json({ error: "Artwork has no body." }, { status: 502 });
    }

    return new Response(object.Body.transformToWebStream(), {
      headers: {
        "Content-Type": object.ContentType || asset.mimeType,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("Unable to read artwork");
    return NextResponse.json({ error: "Artwork unavailable." }, { status: 502 });
  }
}
