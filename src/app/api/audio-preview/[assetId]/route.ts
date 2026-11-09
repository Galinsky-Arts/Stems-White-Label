import { NextResponse } from "next/server";

import { verifyPreviewAccess } from "@/lib/audio-preview-access";
import { db } from "@/lib/db";
import {
  getPrivateObject,
  headPrivateObject,
} from "@/lib/object-storage";
import { getCurrentTenant } from "@/lib/tenant";

export const runtime = "nodejs";

type PreviewRouteProps = {
  params: Promise<{ assetId: string }>;
};

function safeRange(value: string | null) {
  if (!value || !/^bytes=\d*-\d*$/.test(value)) return null;
  return value;
}

async function resolvePreviewAsset(assetId: string) {
  const tenant = await getCurrentTenant();

  if (!tenant) return null;

  return db.audioAsset.findFirst({
    where: {
      id: assetId,
      tenantId: tenant.id,
      kind: "PREVIEW",
      status: "READY",
      storageKey: { not: null },
      work: { status: "PUBLISHED" },
    },
    select: {
      storageKey: true,
      mimeType: true,
    },
  });
}

function copyObjectHeaders(
  output: Headers,
  object: {
    ContentLength?: number;
    ContentRange?: string;
    ContentType?: string;
    ETag?: string;
    LastModified?: Date;
  },
  fallbackMimeType: string | null,
) {
  output.set(
    "Content-Type",
    object.ContentType || fallbackMimeType || "application/octet-stream",
  );
  output.set("Cache-Control", "private, no-store");
  output.set("Accept-Ranges", "bytes");

  if (object.ContentLength !== undefined) {
    output.set("Content-Length", String(object.ContentLength));
  }
  if (object.ContentRange) {
    output.set("Content-Range", object.ContentRange);
  }
  if (object.ETag) {
    output.set("ETag", object.ETag);
  }
  if (object.LastModified) {
    output.set("Last-Modified", object.LastModified.toUTCString());
  }
}

async function authorize(request: Request, assetId: string) {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";

  if (!verifyPreviewAccess(assetId, expires, signature)) {
    return {
      error: NextResponse.json(
        { error: "Preview link expired or invalid." },
        { status: 403 },
      ),
      asset: null,
    };
  }

  const asset = await resolvePreviewAsset(assetId);

  if (!asset?.storageKey) {
    return {
      error: NextResponse.json(
        { error: "Preview not found." },
        { status: 404 },
      ),
      asset: null,
    };
  }

  return { error: null, asset };
}

export async function GET(request: Request, { params }: PreviewRouteProps) {
  const { assetId } = await params;
  const auth = await authorize(request, assetId);
  if (auth.error) return auth.error;
  if (!auth.asset?.storageKey) {
    return NextResponse.json({ error: "Preview not found." }, { status: 404 });
  }

  const range = safeRange(request.headers.get("range"));

  try {
    const object = await getPrivateObject(auth.asset.storageKey, { range });

    if (!object.Body) {
      return NextResponse.json(
        { error: "Preview source has no body." },
        { status: 502 },
      );
    }

    const headers = new Headers();
    copyObjectHeaders(headers, object, auth.asset.mimeType);

    return new Response(object.Body.transformToWebStream(), {
      status: object.ContentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    console.error("Unable to read private preview object");
    return NextResponse.json(
      { error: "Preview source is unavailable." },
      { status: 502 },
    );
  }
}

export async function HEAD(request: Request, { params }: PreviewRouteProps) {
  const { assetId } = await params;
  const auth = await authorize(request, assetId);
  if (auth.error) return auth.error;
  if (!auth.asset?.storageKey) {
    return NextResponse.json({ error: "Preview not found." }, { status: 404 });
  }

  try {
    const object = await headPrivateObject(auth.asset.storageKey);
    const headers = new Headers();
    copyObjectHeaders(headers, object, auth.asset.mimeType);

    return new Response(null, { status: 200, headers });
  } catch (error) {
    console.error("Unable to inspect private preview object");
    return NextResponse.json(
      { error: "Preview source is unavailable." },
      { status: 502 },
    );
  }
}
