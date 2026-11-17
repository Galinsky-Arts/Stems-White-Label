import { NextResponse } from "next/server";

import { PASSWORD_LIMITS, clearAttempts, consumeAttempt, rateLimitKey } from "@/lib/auth-rate-limit";
import { db } from "@/lib/db";
import { safeInternalCallback } from "@/lib/internal-callback";
import { verifyPassword } from "@/lib/password";
import { PASSWORD_SESSION_MAX_AGE_SECONDS, createPasswordSession, sessionCookieName } from "@/lib/password-session";

function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

const INVALID = "Email or password is incorrect.";

/** Built-in email+password sign-in. Same-origin is enforced by src/proxy.ts. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password || email.length > 320) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  const emailKey = rateLimitKey("email", email);
  const [ipLimit, emailLimit] = await Promise.all([
    consumeAttempt(rateLimitKey("ip", clientIp(request)), PASSWORD_LIMITS.ip),
    consumeAttempt(emailKey, PASSWORD_LIMITS.email),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    const retryAfter = Math.ceil(Math.max(ipLimit.retryAfterMs, emailLimit.retryAfterMs) / 1000);
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, passwordHash: true },
  });
  // Always run scrypt so timing does not reveal whether the account exists.
  const valid = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !valid) {
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  await clearAttempts(emailKey);
  const { sessionToken, expires } = await createPasswordSession(user.id);
  const redirectTo = safeInternalCallback(typeof body?.callbackUrl === "string" ? body.callbackUrl : undefined) ?? "/admin";
  const response = NextResponse.json({ ok: true, redirect: redirectTo }, { headers: { "Cache-Control": "no-store" } });
  const cookieName = sessionCookieName();
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cookieName.startsWith("__Secure-"),
    expires,
    maxAge: PASSWORD_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
