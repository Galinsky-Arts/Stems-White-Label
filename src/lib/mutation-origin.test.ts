import assert from "node:assert/strict";
import test from "node:test";
import { mutationOriginAllowed } from "./mutation-origin";
const base = { origin: "https://label.example", host: "label.example", requestUrl: "http://internal:10000/api/admin/works", production: true };

test("privileged writes require exact tenant origin even behind an internal proxy", () => {
  assert.equal(mutationOriginAllowed(base), true);
  assert.equal(mutationOriginAllowed({ ...base, fetchSite: "same-origin" }), true);
  for (const origin of [null, "null", "https://other.label.example", "https://evil.example", "http://label.example", "https://label.example:444", "https://label.example/path", "https://label.example@evil.example", "https://label.example/"]) {
    assert.equal(mutationOriginAllowed({ ...base, origin }), false, String(origin));
  }
  for (const host of [null, "label.example,evil.example", "label.example/path", "label.example@evil.example", "label.example\r\n"]) assert.equal(mutationOriginAllowed({ ...base, host }), false);
  assert.equal(mutationOriginAllowed({ ...base, fetchSite: "cross-site" }), false);
});

test("local development origin preserves protocol and port", () => {
  assert.equal(mutationOriginAllowed({ origin: "http://localhost:3000", host: "localhost:3000", requestUrl: "http://localhost:3000/api/admin/works", production: false }), true);
});
