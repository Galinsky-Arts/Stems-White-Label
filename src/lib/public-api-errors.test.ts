import assert from "node:assert/strict";
import test from "node:test";
import { publicAnalyticsError } from "./public-api-errors";
test("public analytics errors preserve only safe validation messages", () => {
  assert.equal(publicAnalyticsError(new Error("Work is required.")), "Work is required.");
  assert.equal(publicAnalyticsError(new Error("database password leaked")), "Unable to record analytics event.");
  assert.equal(publicAnalyticsError({ message: "Internal SQL details" }), "Unable to record analytics event.");
});
