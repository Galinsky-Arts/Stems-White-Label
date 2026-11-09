import assert from "node:assert/strict";
import test from "node:test";
import { safeObjectContentType } from "./object-content-type";

test("object metadata cannot serve HTML, JavaScript or active SVG from media routes", () => {
  for (const type of [null, undefined, "text/html", "text/html; charset=utf-8", "application/xhtml+xml", "text/javascript", "application/javascript", "image/svg+xml", "text/plain\r\nX-Injected: yes"]) assert.equal(safeObjectContentType(type), "application/octet-stream");
  assert.equal(safeObjectContentType("IMAGE/PNG"), "image/png");
  assert.equal(safeObjectContentType("audio/mpeg"), "audio/mpeg");
  assert.equal(safeObjectContentType("application/json; charset=utf-8"), "application/json");
});
