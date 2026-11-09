import assert from "node:assert/strict";
import test from "node:test";
import { MAX_WEBHOOK_BYTES, readWebhookBody } from "./webhook-body";

function request(body: BodyInit, headers?: HeadersInit) {
  return new Request("https://store.example/api/stripe/webhook", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

test("webhook body preserves signed UTF-8 bytes across chunk boundaries", async () => {
  const payload = '{"name":"Café 🎵"}';
  const encoded = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of encoded) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.equal(await readWebhookBody(request(stream)), payload);
});

test("webhook body bounds declared and actual sizes", async () => {
  await assert.rejects(readWebhookBody(request("{}", { "content-length": String(MAX_WEBHOOK_BYTES + 1) })));
  await assert.rejects(readWebhookBody(request("{}", { "content-length": "NaN" })));
  await assert.rejects(readWebhookBody(request("x".repeat(MAX_WEBHOOK_BYTES + 1))));
  assert.equal((await readWebhookBody(request("x".repeat(MAX_WEBHOOK_BYTES)))).length, MAX_WEBHOOK_BYTES);
});

test("webhook body rejects malformed UTF-8 and stalled streams", async () => {
  const invalid = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(0xff)); c.close(); } });
  await assert.rejects(readWebhookBody(request(invalid)));
  let canceled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  await assert.rejects(readWebhookBody(request(stalled), 10), /timed out/);
  assert.equal(canceled, true);
});
