import assert from "node:assert/strict";
import test from "node:test";
import { safeInternalCallback } from "./internal-callback";

test("post-sign-in navigation cannot become a protocol-relative or control-character redirect", () => {
  for (const value of [undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "/%5cevil.example", "/%2fevil.example", "/\r\nevil.example", "/%0aevil.example"]) assert.equal(safeInternalCallback(value), null, String(value));
  assert.equal(safeInternalCallback("/library"), "/library");
  assert.equal(safeInternalCallback("/team/accept?token=fixture-123"), "/team/accept?token=fixture-123");
});
