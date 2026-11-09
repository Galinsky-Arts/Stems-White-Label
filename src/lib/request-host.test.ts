import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestHostname } from "./request-host";

test("tenant routing accepts only one well-formed Host value", () => {
  assert.equal(parseRequestHostname("Label.Example.:443"), "label.example");
  assert.equal(parseRequestHostname("localhost:3000"), "localhost");
  assert.equal(parseRequestHostname("[::1]:3000"), "::1");
  for (const value of ["", "label.example,evil.example", "evil.example, label.example", "label.example/path", "https://label.example", "label.example@evil.example", "label.example?x=1", "label.example#x", "label.example\r\n", "label..example", "-bad.example", "bad-.example", "bad_name.example", "label.example:99999", "label.example:443:1"]) assert.equal(parseRequestHostname(value), null, value);
});
