import assert from "node:assert/strict";
import test from "node:test";

import { onboardingRefreshAllowed } from "./commerce";

import {
  calculatePlatformFeeCents,
  commerceReadiness,
  normalizeConnectCountry,
  normalizePlatformFeeBps,
} from "./commerce";

test("platform fees use integer basis points and cent rounding", () => {
  assert.equal(calculatePlatformFeeCents(10000, 750), 750);
  assert.equal(calculatePlatformFeeCents(12500, 750), 938);
  assert.equal(calculatePlatformFeeCents(99, 10000), 99);
});

test("platform fee validation is bounded", () => {
  assert.equal(normalizePlatformFeeBps(0), 0);
  assert.equal(normalizePlatformFeeBps(10000), 10000);
  assert.throws(() => normalizePlatformFeeBps(-1));
  assert.throws(() => normalizePlatformFeeBps(10001));
  assert.throws(() => normalizePlatformFeeBps(2.5));
});

test("Connect country normalizes to ISO-style uppercase", () => {
  assert.equal(normalizeConnectCountry("us"), "US");
  assert.equal(normalizeConnectCountry(" gb "), "GB");
  assert.throws(() => normalizeConnectCountry("USA"));
});

test("commerce is ready only after onboarding, charges, and payouts are ready", () => {
  assert.deepEqual(
    commerceReadiness({
      stripeAccountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      disabledReason: null,
    }),
    { ready: false, status: "NOT_CONNECTED" },
  );

  assert.equal(
    commerceReadiness({
      stripeAccountId: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      disabledReason: null,
    }).status,
    "RESTRICTED",
  );

  assert.deepEqual(
    commerceReadiness({
      stripeAccountId: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      disabledReason: null,
    }),
    { ready: true, status: "READY" },
  );
});

test("GET onboarding refresh cannot initiate or revive an old account flow", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  assert.equal(onboardingRefreshAllowed(null, now), false);
  assert.equal(onboardingRefreshAllowed({ stripeAccountId: null, onboardingStartedAt: now }, now), false);
  assert.equal(onboardingRefreshAllowed({ stripeAccountId: "acct_fixture", onboardingStartedAt: null }, now), false);
  assert.equal(onboardingRefreshAllowed({ stripeAccountId: "acct_fixture", onboardingStartedAt: new Date(now.getTime() - 31 * 60 * 1000) }, now), false);
  assert.equal(onboardingRefreshAllowed({ stripeAccountId: "acct_fixture", onboardingStartedAt: new Date(now.getTime() + 1000) }, now), false);
  assert.equal(onboardingRefreshAllowed({ stripeAccountId: "acct_fixture", onboardingStartedAt: now }, now), true);
});
