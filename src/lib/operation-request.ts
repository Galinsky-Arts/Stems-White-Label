/** Bounded JSON reads for the two small incident-action fields. */
export async function readOperationBody(request: Request, timeoutMs = 5000) {
  if (!request.body) throw new Error("Missing incident body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
  try {
    while (true) {
      const result = await reader.read();
      if (timedOut) throw new Error("Incident body timeout.");
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error("Incident body too large.");
      }
      chunks.push(result.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid incident body.");
    return parsed as { alertKey?: unknown; action?: unknown };
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
