import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export function configuredPlatformSuperAdminEmails() {
  return new Set(
    (process.env.PLATFORM_SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function platformEmailIsBootstrapAdmin(email: string | null | undefined) {
  if (!email) return false;
  return configuredPlatformSuperAdminEmails().has(email.trim().toLowerCase());
}

export async function getPlatformAccess() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      platformRole: true,
      emailVerified: true,
    },
  });
  if (!user) return null;

  const allowed =
    user.platformRole === "SUPER_ADMIN" ||
    (Boolean(user.emailVerified) && platformEmailIsBootstrapAdmin(user.email));

  return allowed ? { session, user } : null;
}

export async function requirePlatformSuperAdmin() {
  const access = await getPlatformAccess();
  if (!access) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      redirect("/auth/sign-in?callbackUrl=/platform-admin");
    }
    redirect("/");
  }
  return access;
}
