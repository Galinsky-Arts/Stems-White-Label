import { NextResponse } from "next/server";

import { verifyWaveformAccess } from "@/lib/audio-preview-access";
import { db } from "@/lib/db";
import { getPrivateObject } from "@/lib/object-storage";
import { getCurrentTenant } from "@/lib/tenant";

export const runtime = "nodejs";

type WaveformRouteProps = {
  params: Promise<{ assetId: string }>;
};

export async function GET(request: Request, { params }: WaveformRouteProps) {
  const { assetId } = await params;
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";

  if (!verifyWaveformAccess(assetId, expires, signature)) {
    return NextResponse.json(
      { error: "Waveform link expired or invalid." },
      { status: 403 },
    );
  }

  const tenant = await getCurrentTenant();

  if (!tenant) {
    return NextResponse.json({ error: "Storefront not found." }, { status: 404 });
  }

  const asset = await db.audioAsset.findFirst({
    where: {
      id: assetId,
      tenantId: tenant.id,
      kind: "PREVIEW",
      status: "READY",
      waveformStorageKey: { not: null },
      work: { status: "PUBLISHED" },
    },
    select: { waveformStorageKey: true },
  });

  if (!asset?.waveformStorageKey) {
    return NextResponse.json({ error: "Waveform not found." }, { status: 404 });
  }

  try {
    const object = await getPrivateObject(asset.waveformStorageKey);

    if (!object.Body) {
      return NextResponse.json(
        { error: "Waveform source has no body." },
        { status: 502 },
      );
    }

    return new Response(object.Body.transformToWebStream(), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Unable to read waveform object");
    return NextResponse.json(
      { error: "Waveform source is unavailable." },
      { status: 502 },
    );
  }
}
