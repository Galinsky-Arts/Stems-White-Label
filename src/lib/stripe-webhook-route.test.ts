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

test("processing failures return a generic 500 and never log event identifiers or provider error text (ported from #38)", async () => {
  const keys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
  const previous = keys.map((key) => process.env[key]);
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_security_fixture";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_offline_security_fixture";
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    // A succeeded refund without a payment intent fails before any database access.
    const payload = JSON.stringify({ id: "evt_private_identifier_123", type: "refund.created",
      data: { object: { id: "re_private_456", status: "succeeded", amount: 100, payment_intent: null } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_offline_security_fixture" });
    const response = await payments(new Request("https://store.example/api/stripe/webhook", {
      method: "POST", body: payload, headers: { "stripe-signature": signature } }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Webhook processing failed." });
    const serialized = JSON.stringify(logged, (_key, value) => value instanceof Error ? value.message : value);
    assert.doesNotMatch(serialized, /evt_private|re_private|payment intent|whsec_|sk_test/i);
  } finally {
    console.error = original;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});
