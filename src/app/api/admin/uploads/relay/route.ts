import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import {
  abortPrivateMultipartUpload,
  completePrivateMultipartUpload,
  startPrivateMultipartUpload,
  uploadPrivatePart,
} from "@/lib/object-storage";
import { RELAY_CHUNK_BYTES, validRelayPart, validRelayParts } from "@/lib/relay-upload";

/**
 * Fallback for catalog uploads when the browser cannot PUT directly to the
 * private bucket (e.g. missing bucket CORS). Chunks are relayed as S3
 * multipart parts; nothing is buffered beyond one chunk (6 MiB).
 * Same-origin is enforced by src/proxy.ts (/api/admin/*).
 */
type Kind = "audio" | "artwork";

async function pendingAsset(kind: Kind, assetId: string, tenantId: string) {
  const asset = kind === "audio"
    ? await db.audioAsset.findFirst({
        where: { id: assetId, tenantId, kind: { in: ["MASTER", "STEM"] }, status: "PENDING" },
        select: { storageKey: true, sizeBytes: true, mimeType: true },
      })
    : await db.artworkAsset.findFirst({
        where: { id: assetId, tenantId, status: "PENDING" },
        select: { storageKey: true, sizeBytes: true, mimeType: true },
      });
  if (!asset?.storageKey || asset.sizeBytes === null) return null;
  return { storageKey: asset.storageKey, sizeBytes: Number(asset.sizeBytes), mimeType: asset.mimeType ?? "application/octet-stream" };
}

function parseKind(value: unknown): Kind | null {
  return value === "audio" || value === "artwork" ? value : null;
}

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return fail("Unauthorized.", 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const kind = parseKind(body?.kind);
  const assetId = typeof body?.assetId === "string" ? body.assetId : "";
  if (!kind || !assetId) return fail("kind and assetId are required.");
  const asset = await pendingAsset(kind, assetId, access.tenant.id);
  if (!asset) return fail("Upload not found or already completed.", 404);
  const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";

  try {
    switch (body?.action) {
      case "start":
        return NextResponse.json({ uploadId: await startPrivateMultipartUpload(asset.storageKey, asset.mimeType), chunkBytes: RELAY_CHUNK_BYTES });
      case "complete":
        if (!uploadId || !validRelayParts(asset.sizeBytes, body?.parts)) return fail("Incomplete upload parts.");
        await completePrivateMultipartUpload({ storageKey: asset.storageKey, uploadId, parts: body.parts as { partNumber: number; etag: string }[] });
        return NextResponse.json({ ok: true });
      case "abort":
        if (uploadId) await abortPrivateMultipartUpload(asset.storageKey, uploadId).catch(() => undefined);
        return NextResponse.json({ ok: true });
      default:
        return fail("Unsupported action.");
    }
  } catch {
    console.error("Relayed upload step failed");
    return fail("Object storage is unavailable.", 503);
  }
}

export async function PUT(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return fail("Unauthorized.", 401);
  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));
  const assetId = url.searchParams.get("assetId") ?? "";
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!kind || !assetId || !uploadId) return fail("kind, assetId and uploadId are required.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELAY_CHUNK_BYTES) return fail("Chunk too large.", 413);
  const asset = await pendingAsset(kind, assetId, access.tenant.id);
  if (!asset) return fail("Upload not found or already completed.", 404);

  // Read at most one chunk; refuse anything larger without buffering it.
  const reader = request.body?.getReader();
  if (!reader) return fail("Empty chunk.");
  const pieces: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > RELAY_CHUNK_BYTES) {
      await reader.cancel().catch(() => undefined);
      return fail("Chunk too large.", 413);
    }
    pieces.push(value);
  }
  if (!validRelayPart({ sizeBytes: asset.sizeBytes, partNumber, byteLength: received })) return fail("Chunk size does not match the declared upload.");
  const chunk = new Uint8Array(received);
  let offset = 0;
  for (const piece of pieces) { chunk.set(piece, offset); offset += piece.byteLength; }

  try {
    const etag = await uploadPrivatePart({ storageKey: asset.storageKey, uploadId, partNumber, body: chunk });
    return NextResponse.json({ partNumber, etag });
  } catch {
    console.error("Relayed upload part failed");
    return fail("Object storage is unavailable.", 503);
  }
}
