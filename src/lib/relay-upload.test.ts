import assert from "node:assert/strict";
import test from "node:test";

import { RELAY_CHUNK_BYTES, expectedRelayParts, shouldFallBackToRelay, validRelayPart, validRelayParts } from "./relay-upload";

test("relay chunks are fixed size with a remainder last part", () => {
  const size = RELAY_CHUNK_BYTES * 2 + 123;
  assert.equal(expectedRelayParts(size), 3);
  assert.equal(expectedRelayParts(1), 1);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 1, byteLength: RELAY_CHUNK_BYTES }), true);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 3, byteLength: 123 }), true);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 3, byteLength: 124 }), false);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 2, byteLength: RELAY_CHUNK_BYTES - 1 }), false);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 4, byteLength: 1 }), false);
  assert.equal(validRelayPart({ sizeBytes: size, partNumber: 0, byteLength: 1 }), false);
});

test("completion requires a contiguous parts list", () => {
  const size = RELAY_CHUNK_BYTES + 1;
  assert.equal(validRelayParts(size, [{ partNumber: 1, etag: "a" }, { partNumber: 2, etag: "b" }]), true);
  assert.equal(validRelayParts(size, [{ partNumber: 1, etag: "a" }]), false);
  assert.equal(validRelayParts(size, [{ partNumber: 2, etag: "a" }, { partNumber: 1, etag: "b" }]), false);
  assert.equal(validRelayParts(size, [{ partNumber: 1, etag: "" }, { partNumber: 2, etag: "b" }]), false);
});

test("fallback triggers on CORS/network failures and storage refusals", () => {
  assert.equal(shouldFallBackToRelay({ networkError: true }), true);
  assert.equal(shouldFallBackToRelay({ status: 403 }), true);
  assert.equal(shouldFallBackToRelay({ status: 503 }), true);
  assert.equal(shouldFallBackToRelay({ status: 400 }), false);
});
