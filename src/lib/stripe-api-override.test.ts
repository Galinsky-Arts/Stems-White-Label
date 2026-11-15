import assert from "node:assert/strict";
import test from "node:test";
import { localStripeApiOverride } from "./stripe";

test("the Stripe API override is loopback-only and disabled in production", () => {
  assert.deepEqual(localStripeApiOverride("http://127.0.0.1:12111", "test"), { host: "127.0.0.1", port: 12111, protocol: "http" });
  assert.deepEqual(localStripeApiOverride("http://localhost:9", "development"), { host: "localhost", port: 9, protocol: "http" });
  assert.deepEqual(localStripeApiOverride("http://127.0.0.1:12111", "production"), {});
  for (const base of ["https://api.stripe.com", "http://evil.example:80", "http://127.0.0.1.evil.example", "not a url", undefined]) {
    assert.deepEqual(localStripeApiOverride(base, "test"), {});
  }
});
