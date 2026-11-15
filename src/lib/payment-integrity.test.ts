import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRefundAmounts,
  assertRefundReplay,
  isPaymentReplayOfSettledOrder,
  isSettledOrderStatus,
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
