import assert from "node:assert/strict";
import test from "node:test";

import { nextLimitState } from "./auth-rate-limit";
import { bootstrapAdminEmail, bootstrapPasswordAction } from "./bootstrap-admin";
import { hashPassword, passwordPolicyError, verifyPassword } from "./password";
import { sessionCookieName } from "./password-session";

test("passwords are salted scrypt hashes that verify only the right password", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse battery", first), true);
  assert.equal(await verifyPassword("correct horse batterY", first), false);
  assert.equal(await verifyPassword("correct horse battery", null), false);
  assert.equal(await verifyPassword("anything", "plaintext"), false);
  assert.equal(await verifyPassword("anything", "scrypt$9999999$8$1$AA$AA"), false);
});

test("password policy enforces length bounds", async () => {
  assert.ok(passwordPolicyError("short"));
  assert.ok(passwordPolicyError(undefined));
  assert.ok(passwordPolicyError("x".repeat(257)));
  assert.equal(passwordPolicyError("twelve chars"), null);
  await assert.rejects(hashPassword("short"));
});

test("fixed-window rate limit locks after the maximum and recovers after the window", () => {
  const rule = { max: 3, windowMs: 60_000, lockMs: 120_000 };
  const t0 = new Date("2026-01-01T00:00:00Z");
  let state = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = nextLimitState(state, rule, t0);
    assert.equal(decision.allowed, true);
    state = decision.state;
  }
  const blocked = nextLimitState(state, rule, t0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 120_000);
  assert.equal(nextLimitState(blocked.state, rule, new Date(t0.getTime() + 90_000)).allowed, false);
  assert.equal(nextLimitState(blocked.state, rule, new Date(t0.getTime() + 121_000)).allowed, true);
});

test("bootstrap admin email and password actions", async () => {
  assert.equal(bootstrapAdminEmail({ PLATFORM_SUPER_ADMIN_EMAILS: " Owner@Example.com , b@example.com" }), "owner@example.com");
  assert.equal(bootstrapAdminEmail({ STEMS_BOOTSTRAP_ADMIN_EMAIL: "X@example.com", PLATFORM_SUPER_ADMIN_EMAILS: "a@example.com" }), "x@example.com");
  assert.equal(bootstrapAdminEmail({}), null);
  const hash = await hashPassword("bootstrap-secret-1");
  assert.equal(await bootstrapPasswordAction(null, "bootstrap-secret-1"), "set");
  assert.equal(await bootstrapPasswordAction({ passwordHash: null, passwordFromBootstrap: false }, "bootstrap-secret-1"), "set");
  assert.equal(await bootstrapPasswordAction({ passwordHash: hash, passwordFromBootstrap: true }, "bootstrap-secret-1"), "unchanged");
  assert.equal(await bootstrapPasswordAction({ passwordHash: hash, passwordFromBootstrap: true }, "bootstrap-secret-2"), "rotate");
  assert.equal(await bootstrapPasswordAction({ passwordHash: hash, passwordFromBootstrap: false }, "bootstrap-secret-2"), "keep-owner-password");
});

test("session cookie name follows NextAuth secure-cookie convention", () => {
  assert.equal(sessionCookieName("https://store.example"), "__Secure-next-auth.session-token");
  assert.equal(sessionCookieName("http://localhost:3000"), "next-auth.session-token");
});
