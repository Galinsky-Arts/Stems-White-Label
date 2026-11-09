import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { POST as payments } from "../app/api/stripe/webhook/route";
import { POST as billing } from "../app/api/stripe/billing/webhook/route";
import { POST as connect } from "../app/api/stripe/connect/webhook/route";
import { MAX_WEBHOOK_BYTES } from "./webhook-body";

test("all webhook routes reject missing, invalid and tampered signatures without exposing payloads", async () => {
  const keys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_BILLING_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET"];
  const previous = keys.map((key) => process.env[key]);
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_security_fixture";
  for (const key of keys.slice(1)) process.env[key] = "whsec_offline_security_fixture";
  try {
    for (const handler of [payments, billing, connect]) {
      const missing = await handler(new Request("https://store.example/api/stripe/webhook", { method: "POST", body: "{}" }));
      assert.equal(missing.status, 400);
      const payload = '{"private":"customer@example.com"}';
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_offline_security_fixture" });
      for (const [body, sig] of [[payload, "invalid"], [payload + " ", signature], ["x".repeat(MAX_WEBHOOK_BYTES + 1), signature]]) {
        const response = await handler(new Request("https://store.example/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": sig! } }));
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.match(data.error, /^Invalid Stripe.*webhook\.$/);
        assert.doesNotMatch(JSON.stringify(data), /customer@|whsec_|payload|signature|stack/i);
      }
    }
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});
