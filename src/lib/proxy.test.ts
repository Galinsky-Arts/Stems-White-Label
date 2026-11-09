import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

test("admin proxy rejects cross-origin writes before application handlers", () => {
  const make = (method: string, origin?: string) => new NextRequest("https://label.example/api/admin/works", { method, headers: { host: "label.example", ...(origin ? { origin } : {}) } });
  assert.equal(proxy(make("POST")).status, 403);
  assert.equal(proxy(make("PATCH", "https://other-label.example")).status, 403);
  assert.equal(proxy(make("DELETE", "https://label.example")).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(make("GET")).headers.get("x-middleware-next"), "1");
});
