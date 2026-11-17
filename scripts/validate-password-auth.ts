import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

import { POST as passwordSignIn } from "../src/app/api/auth/password/route";
import { bootstrapAdmin } from "../src/lib/bootstrap-admin";
import { db } from "../src/lib/db";

async function main() {
  const suffix = Date.now().toString(36);
  const email = "owner-" + suffix + "@example.com";
  const tenantSlug = "pw-tenant-" + suffix;
  const prisma = new PrismaClient();
  const tenant = await db.tenant.create({ data: { name: "Password Tenant", slug: tenantSlug } });
  const ip = "198.51.100." + (Date.now() % 200);
  function attempt(password: string, from = ip, who = email) {
    return passwordSignIn(new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify({ email: who.toUpperCase(), password, callbackUrl: "/admin/catalog" }),
    }));
  }
  try {
    const env = { STEMS_BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-pass-" + suffix, PLATFORM_SUPER_ADMIN_EMAILS: email, DEFAULT_TENANT_SLUG: tenantSlug };
    assert.equal((await bootstrapAdmin(prisma, {})).status, "skipped");
    const first = await bootstrapAdmin(prisma, env);
    assert.deepEqual(first, { status: "ready", action: "set", tenantMembership: true });
    assert.equal((await bootstrapAdmin(prisma, env)).action, "unchanged");
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
    assert.equal(user.platformRole, "SUPER_ADMIN");
    assert.ok(user.emailVerified);
    assert.equal(user.memberships[0]?.role, "OWNER");
    assert.ok(!user.passwordHash!.includes(env.STEMS_BOOTSTRAP_ADMIN_PASSWORD));

    const ok = await attempt(env.STEMS_BOOTSTRAP_ADMIN_PASSWORD);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, redirect: "/admin/catalog" });
    const cookie = ok.headers.get("set-cookie") ?? "";
    assert.match(cookie, /next-auth\.session-token=[0-9a-f]{64}/);
    assert.match(cookie, /HttpOnly/i);
    const token = cookie.match(/session-token=([0-9a-f]{64})/)![1]!;
    assert.equal((await db.session.findUniqueOrThrow({ where: { sessionToken: token } })).userId, user.id);

    assert.equal((await attempt("wrong-password-123")).status, 401);
    assert.equal((await attempt("whatever-password", ip, "nobody-" + suffix + "@example.com")).status, 401);
    // Per-email lockout after 5 attempts in the window (one success reset the counter).
    for (let index = 0; index < 4; index += 1) assert.equal((await attempt("wrong-password-123", "203.0.113." + index)).status, 401);
    const locked = await attempt(env.STEMS_BOOTSTRAP_ADMIN_PASSWORD, "203.0.113.99");
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);

    // Rotating the env value rotates a bootstrap password; an owner-chosen password is kept.
    assert.equal((await bootstrapAdmin(prisma, { ...env, STEMS_BOOTSTRAP_ADMIN_PASSWORD: "rotated-pass-" + suffix })).action, "rotate");
    await db.user.update({ where: { id: user.id }, data: { passwordFromBootstrap: false } });
    assert.equal((await bootstrapAdmin(prisma, env)).action, "keep-owner-password");
    console.log("Password sign-in integration validation passed (bootstrap, hashing, session cookie, rate limit).");
  } finally {
    await db.user.deleteMany({ where: { email } });
    await db.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
    await db.authRateLimit.deleteMany({});
    await prisma.$disconnect();
    await db.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
