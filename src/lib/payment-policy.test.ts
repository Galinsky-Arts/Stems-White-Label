import assert from "node:assert/strict";
import test from "node:test";
import { assertCheckoutPaymentMatches, type CheckoutPaymentEvidence } from "./payment-policy";

const order = { tenantId: "tenant-a", stripeCheckoutSessionId: "cs_a", totalCents: 12500, currency: "USD" };
const evidence: CheckoutPaymentEvidence = { sessionId: "cs_a", tenantId: "tenant-a", amountTotal: 12500, currency: "usd", mode: "payment", paymentStatus: "paid" };

test("fulfillment accepts only the exact server-recorded paid checkout", () => {
  assert.doesNotThrow(() => assertCheckoutPaymentMatches(order, evidence));
  const invalid: Partial<CheckoutPaymentEvidence>[] = [
    { sessionId: "cs_other" }, { tenantId: "tenant-b" }, { tenantId: null },
    { amountTotal: 12499 }, { amountTotal: null }, { amountTotal: NaN },
    { currency: "eur" }, { currency: null }, { mode: "subscription" },
    { paymentStatus: "unpaid" }, { paymentStatus: "no_payment_required" },
  ];
  for (const change of invalid) {
    assert.throws(() => assertCheckoutPaymentMatches(order, { ...evidence, ...change }));
  }
  assert.throws(() => assertCheckoutPaymentMatches({ ...order, stripeCheckoutSessionId: null }, evidence));
});
