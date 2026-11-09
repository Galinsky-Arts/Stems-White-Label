import assert from "node:assert/strict";
import test from "node:test";
import { privateUrlExpiry } from "./object-storage";
test("private signed URLs enforce bounded expiry", () => {
  assert.equal(privateUrlExpiry(undefined, 300), 300);
  assert.equal(privateUrlExpiry(60, 300), 60);
  for (const invalid of [0, 59, 901, Number.NaN, 1.2, Number.POSITIVE_INFINITY])
    assert.throws(() => privateUrlExpiry(invalid, 300));
});
