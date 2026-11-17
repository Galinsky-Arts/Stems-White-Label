import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { PASSWORD_LIMITS, consumeAttempt, rateLimitKey } from "@/lib/auth-rate-limit";
import { db } from "@/lib/db";
import { hashPassword, passwordPolicyError, verifyPassword } from "@/lib/password";

/** Signed-in users set or change their built-in password. */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = body?.newPassword;
  const policyError = passwordPolicyError(newPassword);
  if (policyError) return NextResponse.json({ error: policyError }, { status: 400 });

  const limit = await consumeAttempt(rateLimitKey("email", "change:" + session.user.id), PASSWORD_LIMITS.email);
  if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });

  const user = await db.user.findUnique({ where: { id: session.user.id }, select: { id: true, passwordHash: true } });
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (user.passwordHash && !(await verifyPassword(currentPassword, user.passwordHash))) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword as string), passwordFromBootstrap: false, passwordUpdatedAt: new Date() },
    }),
    // Changing the password signs out every other session.
    db.session.deleteMany({ where: { userId: user.id, sessionToken: { not: currentSessionToken(request) ?? "" } } }),
  ]);
  return NextResponse.json({ ok: true });
}

function currentSessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}
