/**
 * Server-relayed upload policy. Browsers send fixed-size chunks to the app, which
 * forwards each as an S3 multipart part. Chunks stay below the proxy's default
 * 10 MB request-body cap and above S3's 5 MiB minimum part size.
 */
export const RELAY_CHUNK_BYTES = 6 * 1024 * 1024;
export const RELAY_MAX_PARTS = 10_000;

export function expectedRelayParts(sizeBytes: number) {
  return Math.max(1, Math.ceil(sizeBytes / RELAY_CHUNK_BYTES));
}

/** Every part except the last must be exactly RELAY_CHUNK_BYTES; the last carries the remainder. */
export function validRelayPart(input: { sizeBytes: number; partNumber: number; byteLength: number }) {
  const parts = expectedRelayParts(input.sizeBytes);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > parts || parts > RELAY_MAX_PARTS) return false;
  const expected = input.partNumber < parts ? RELAY_CHUNK_BYTES : input.sizeBytes - RELAY_CHUNK_BYTES * (parts - 1);
  return input.byteLength === expected;
}

/** Parts list for completion: contiguous 1..n, each with a non-empty ETag. */
export function validRelayParts(sizeBytes: number, parts: unknown): parts is { partNumber: number; etag: string }[] {
  if (!Array.isArray(parts) || parts.length !== expectedRelayParts(sizeBytes)) return false;
  return parts.every((part, index) => part && typeof part === "object" &&
    (part as { partNumber?: unknown }).partNumber === index + 1 &&
    typeof (part as { etag?: unknown }).etag === "string" && ((part as { etag: string }).etag).length > 0 && ((part as { etag: string }).etag).length < 200);
}

/** Direct-to-bucket PUT failed in a way a relay can fix (CORS/network/403 from storage). */
export function shouldFallBackToRelay(outcome: { networkError?: boolean; status?: number }) {
  return Boolean(outcome.networkError) || outcome.status === 403 || outcome.status === 0 || (outcome.status !== undefined && outcome.status >= 500);
}
