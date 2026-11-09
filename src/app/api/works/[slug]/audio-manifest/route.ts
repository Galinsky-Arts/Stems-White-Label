import { NextResponse } from "next/server";

import { buildPlayerManifest } from "@/lib/player-manifest";
import { getCurrentTenant } from "@/lib/tenant";

type ManifestRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(_request: Request, { params }: ManifestRouteProps) {
  const tenant = await getCurrentTenant();

  if (!tenant) {
    return NextResponse.json({ error: "Storefront not found." }, { status: 404 });
  }

  const { slug } = await params;

  try {
    const manifest = await buildPlayerManifest(tenant.id, slug);

    if (!manifest) {
      return NextResponse.json({ error: "Work not found." }, { status: 404 });
    }

    return NextResponse.json(manifest, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Unable to build audio manifest");
    return NextResponse.json(
      { error: "Preview delivery is not configured." },
      { status: 503 },
    );
  }
}
