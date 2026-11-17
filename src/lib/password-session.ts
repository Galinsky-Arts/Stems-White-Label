import { randomBytes } from "node:crypto";

import { db } from "@/lib/db";

/** Matches the database session lifetime configured in authOptions. */
export const PASSWORD_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** NextAuth v4 cookie naming: secure-prefixed when NEXTAUTH_URL is https. */
export function sessionCookieName(nextAuthUrl = process.env.NEXTAUTH_URL ?? "") {
  return nextAuthUrl.startsWith("https://") ? "__Secure-next-auth.session-token" : "next-auth.session-token";
}

/**
 * Creates a NextAuth database session (same table the adapter reads), so
 * password sign-in yields an ordinary NextAuth session for getServerSession.
 */
export async function createPasswordSession(userId: string, now = new Date()) {
  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(now.getTime() + PASSWORD_SESSION_MAX_AGE_SECONDS * 1000);
  await db.session.create({ data: { sessionToken, userId, expires } });
  return { sessionToken, expires };
}
