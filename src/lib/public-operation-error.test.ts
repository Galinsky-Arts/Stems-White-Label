import assert from "node:assert/strict";
import test from "node:test";
import { publicOperationError, publicStoredError } from "./public-operation-error";

test("public APIs retain fixed validation guidance and hide arbitrary diagnostics", () => {
  assert.equal(publicOperationError(new Error("Cart is empty."), "Unable to quote cart."), "Cart is empty.");
  for (const diagnostic of [new Error("postgresql://user:secret@internal/db"), new Error("Stripe InvalidRequestError customer cus_private"), new Error("Signature mismatch for body customer@example.com"), { message: "Cart is empty." }, "secret", null]) {
    assert.equal(publicOperationError(diagnostic, "Unable to start checkout."), "Unable to start checkout.");
  }
});

test("stored diagnostics never expose historical provider or private object details", () => {
  for (const value of [null, undefined, ""]) assert.equal(publicStoredError(value), null);
  for (const value of ["s3://private/customer@example.com/master.wav", "postgresql://user:secret@internal/db", "request signature token=secret", { message: "sensitive" }]) {
    assert.equal(publicStoredError(value), "Processing failed. Please retry or contact support.");
  }
});
