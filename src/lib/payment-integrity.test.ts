import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRefundAmounts,
  assertRefundReplay,
  isPaymentReplayOfSettledOrder,
  isSettledOrderStatus,
  paymentSuccessDisposition,
  refundAllowedForOrder,
  autoRefundCanceledPaymentsEnabled,
} from "./payment-integrity";

test("refund amounts are positive integer cents bounded by captured funds", () => {
  assert.equal(assertRefundAmounts({ capturedCents: 12500, previousRefundsCents: 2500, refundCents: 10000 }), 12500);
  for (const refundCents of [0, -1, 2.5, Infinity, Number.NaN]) {
    assert.throws(() => assertRefundAmounts({ capturedCents: 12500, previousRefundsCents: 0, refundCents }), /positive integer/);
  }
  assert.throws(() => assertRefundAmounts({ capturedCents: 12500, previousRefundsCents: 2500, refundCents: 10001 }), /exceeds/);
  assert.throws(() => assertRefundAmounts({ capturedCents: 0, previousRefundsCents: 0, refundCents: 1 }), /exceeds/);
  assert.throws(() => assertRefundAmounts({ capturedCents: 100, previousRefundsCents: -1, refundCents: 1 }), /exceeds/);
});

test("a provider refund ID cannot be replayed for another payment or amount", () => {
  assert.doesNotThrow(() => assertRefundReplay({ paymentId: "p1", amountCents: 25 }, { paymentId: "p1", amountCents: 25 }));
  assert.throws(() => assertRefundReplay({ paymentId: "p1", amountCents: 25 }, { paymentId: "p2", amountCents: 25 }));
  assert.throws(() => assertRefundReplay({ paymentId: "p1", amountCents: 25 }, { paymentId: "p1", amountCents: 30 }));
});

test("payment-success replays never reopen settled or refunded orders", () => {
  for (const status of ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]) {
    assert.equal(isSettledOrderStatus(status), true);
    assert.equal(isPaymentReplayOfSettledOrder(status), true);
  }
  for (const status of ["PENDING", "CHECKOUT_CREATED", "PAYMENT_FAILED", "CANCELED"]) {
    assert.equal(isPaymentReplayOfSettledOrder(status), false);
  }
});

test("a payment arriving for a canceled order is reconciled, never fulfilled", () => {
  assert.equal(paymentSuccessDisposition("CANCELED"), "reconcile");
  for (const status of ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]) assert.equal(paymentSuccessDisposition(status), "replay");
  for (const status of ["PENDING", "CHECKOUT_CREATED", "PAYMENT_FAILED"]) assert.equal(paymentSuccessDisposition(status), "fulfill");
});

test("refunds are allowed only for settled orders or flagged canceled payments", () => {
  assert.equal(refundAllowedForOrder({ status: "PAID" }), true);
  assert.equal(refundAllowedForOrder({ status: "CANCELED", reconciliation: null }), false);
  assert.equal(refundAllowedForOrder({ status: "CANCELED", reconciliation: "NEEDS_REVIEW" }), true);
  assert.equal(refundAllowedForOrder({ status: "PENDING", reconciliation: null }), false);
});

test("automatic refunds of canceled-order payments are off unless explicitly enabled", () => {
  assert.equal(autoRefundCanceledPaymentsEnabled({}), false);
  assert.equal(autoRefundCanceledPaymentsEnabled({ STEMS_AUTO_REFUND_CANCELED_PAYMENTS: "1" }), false);
  assert.equal(autoRefundCanceledPaymentsEnabled({ STEMS_AUTO_REFUND_CANCELED_PAYMENTS: "true" }), true);
});
