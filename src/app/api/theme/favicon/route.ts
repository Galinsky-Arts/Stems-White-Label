import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getPrivateObject } from "@/lib/object-storage";
import { getCurrentTenant } from "@/lib/tenant";

export const runtime = "nodejs";

export async function GET() {
  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: "Storefront not found." }, { status: 404 });

  const theme = await db.tenantTheme.findUnique({
    where: { tenantId: tenant.id },
    include: {
      faviconAsset: true,
    },
  });
  const asset = theme?.faviconAsset;

  if (!asset || asset.status !== "READY" || !asset.storageKey) {
    return NextResponse.json({ error: "Brand asset not found." }, { status: 404 });
  }

  try {
    const object = await getPrivateObject(asset.storageKey);
    if (!object.Body) {
      return NextResponse.json({ error: "Brand asset unavailable." }, { status: 502 });
    }

    return new Response(object.Body.transformToWebStream(), {
      headers: {
        "Content-Type": object.ContentType || asset.mimeType,
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Unable to read favicon asset");
    return NextResponse.json({ error: "Brand asset unavailable." }, { status: 502 });
  }
}
