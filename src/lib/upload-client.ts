import { RELAY_CHUNK_BYTES, shouldFallBackToRelay } from "./relay-upload";

/**
 * Browser upload: try the presigned direct PUT first; if the bucket refuses the
 * browser (CORS/network/403/5xx), relay the file through the app in chunks.
 */
export async function uploadToPrivateStorage(input: {
  file: Blob;
  uploadUrl: string;
  requiredHeaders?: Record<string, string>;
  kind: "audio" | "artwork";
  assetId: string;
  onFallback?: () => void;
  fetchImpl?: typeof fetch;
}) {
  const doFetch = input.fetchImpl ?? fetch;
  let outcome: { networkError?: boolean; status?: number };
  try {
    const direct = await doFetch(input.uploadUrl, { method: "PUT", headers: input.requiredHeaders, body: input.file });
    if (direct.ok) return "direct" as const;
    outcome = { status: direct.status };
  } catch {
    outcome = { networkError: true };
  }
  if (!shouldFallBackToRelay(outcome)) throw new Error("Object-storage upload failed.");
  input.onFallback?.();
  return relayUpload(input, doFetch);
}

async function relayCall(doFetch: typeof fetch, body: Record<string, unknown>) {
  const response = await doFetch("/api/admin/uploads/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Upload relay failed.");
  return payload;
}

async function relayUpload(input: { file: Blob; kind: "audio" | "artwork"; assetId: string }, doFetch: typeof fetch) {
  const base = { kind: input.kind, assetId: input.assetId };
  const { uploadId } = await relayCall(doFetch, { ...base, action: "start" }) as { uploadId: string };
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let offset = 0, partNumber = 1; offset < input.file.size || partNumber === 1; offset += RELAY_CHUNK_BYTES, partNumber += 1) {
      const chunk = input.file.slice(offset, offset + RELAY_CHUNK_BYTES);
      const query = new URLSearchParams({ ...base, uploadId, partNumber: String(partNumber) });
      let response: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await doFetch("/api/admin/uploads/relay?" + query.toString(), { method: "PUT", body: chunk });
        if (response.ok || response.status < 500) break;
      }
      const payload = await response!.json().catch(() => ({}));
      if (!response!.ok) throw new Error(payload.error || "Upload relay failed.");
      parts.push({ partNumber, etag: payload.etag });
      if (offset + RELAY_CHUNK_BYTES >= input.file.size) break;
    }
    await relayCall(doFetch, { ...base, action: "complete", uploadId, parts });
  } catch (error) {
    await relayCall(doFetch, { ...base, action: "abort", uploadId }).catch(() => undefined);
    throw error;
  }
  return "relay" as const;
}
