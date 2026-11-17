import type { PrismaClient } from "@prisma/client";

import { hashPassword, verifyPassword } from "./password";

export const BOOTSTRAP_PASSWORD_ENV = "STEMS_BOOTSTRAP_ADMIN_PASSWORD";

/** Email for the bootstrap admin: explicit override, else the first platform super-admin email. */
export function bootstrapAdminEmail(env: Record<string, string | undefined> = process.env) {
  const explicit = env.STEMS_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (explicit) return explicit;
  return (env.PLATFORM_SUPER_ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).find(Boolean) ?? null;
}

/**
 * Whether the stored password should be (re)set from the env var:
 * - no password yet: set it;
 * - still the bootstrap password but the env value changed: rotate it;
 * - the owner already chose their own password: never overwrite it.
 */
export async function bootstrapPasswordAction(user: { passwordHash: string | null; passwordFromBootstrap: boolean } | null, password: string) {
  if (!user || !user.passwordHash) return "set" as const;
  if (!user.passwordFromBootstrap) return "keep-owner-password" as const;
  return (await verifyPassword(password, user.passwordHash)) ? ("unchanged" as const) : ("rotate" as const);
}

export async function bootstrapAdmin(client: PrismaClient, env: Record<string, string | undefined> = process.env) {
  const password = env[BOOTSTRAP_PASSWORD_ENV];
  const email = bootstrapAdminEmail(env);
  if (!password) return { status: "skipped", reason: BOOTSTRAP_PASSWORD_ENV + " is not set" };
  if (!email) return { status: "skipped", reason: "PLATFORM_SUPER_ADMIN_EMAILS (or STEMS_BOOTSTRAP_ADMIN_EMAIL) is not set" };

  const existing = await client.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, passwordHash: true, passwordFromBootstrap: true, emailVerified: true },
  });
  const action = await bootstrapPasswordAction(existing, password);
  const passwordData = action === "set" || action === "rotate"
    ? { passwordHash: await hashPassword(password), passwordFromBootstrap: true, passwordUpdatedAt: new Date() }
    : {};

  const user = existing
    ? await client.user.update({
        where: { id: existing.id },
        data: { ...passwordData, platformRole: "SUPER_ADMIN", emailVerified: existing.emailVerified ?? new Date() },
      })
    : await client.user.create({
        data: { email, emailVerified: new Date(), platformRole: "SUPER_ADMIN", ...passwordData },
      });

  const slug = env.DEFAULT_TENANT_SLUG ?? "unsealed-records";
  const tenant = await client.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (tenant) {
    await client.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role: "OWNER" },
      create: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    });
  }
  return { status: "ready", action, tenantMembership: Boolean(tenant) };
}
