import assert from "node:assert/strict";
import test from "node:test";
import { readOperationBody } from "./operation-request";
test("incident input accepts a small JSON object and rejects malformed, missing or oversized input", async () => {
  const request = (body: string) => new Request("https://example.test", { method: "POST", body });
  assert.deepEqual(await readOperationBody(request('{"action":"ACKNOWLEDGE"}')), { action: "ACKNOWLEDGE" });
  for (const body of ["[]", "null", "{", "x".repeat(4097)]) await assert.rejects(readOperationBody(request(body)));
  await assert.rejects(readOperationBody(new Request("https://example.test")));
});
test("incident input cancels slow streaming bodies at the deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const request = new Request("https://example.test", { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(readOperationBody(request, 10), /timeout/);
  assert.equal(cancelled, true);
});
