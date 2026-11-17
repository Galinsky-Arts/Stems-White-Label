import { PrismaClient } from "@prisma/client";

import { bootstrapAdmin } from "../src/lib/bootstrap-admin";

/**
 * Provisions the owner's built-in password sign-in from
 * STEMS_BOOTSTRAP_ADMIN_PASSWORD (Render env var) for the first
 * PLATFORM_SUPER_ADMIN_EMAILS address, and makes that user OWNER of the
 * default tenant. Never logs the password or email.
 */
const prisma = new PrismaClient();

bootstrapAdmin(prisma)
  .then((result) => console.log("Bootstrap admin: " + result.status + ("reason" in result ? " (" + result.reason + ")" : " (" + result.action + ", tenant membership " + (result.tenantMembership ? "ok" : "missing tenant") + ")")))
  .catch(() => {
    console.error("Bootstrap admin failed.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
