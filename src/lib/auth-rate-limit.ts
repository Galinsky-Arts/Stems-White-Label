import { createHash } from "node:crypto";

import { db } from "@/lib/db";

export const PASSWORD_LIMITS = {
  /** attempts per email per window */
  email: { max: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
  /** attempts per client IP per window */
  ip: { max: 30, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
} as const;

export type LimitRule = { max: number; windowMs: number; lockMs: number };
export type LimitState = { count: number; windowStart: Date; lockedUntil: Date | null };

/** Pure fixed-window decision: returns the next stored state and whether the attempt may proceed. */
export function nextLimitState(previous: LimitState | null, rule: LimitRule, now: Date) {
  if (previous?.lockedUntil && previous.lockedUntil > now) {
    return { allowed: false, state: previous, retryAfterMs: previous.lockedUntil.getTime() - now.getTime() };
  }
  const freshWindow = !previous || now.getTime() - previous.windowStart.getTime() >= rule.windowMs;
  const count = freshWindow ? 1 : previous!.count + 1;
  const windowStart = freshWindow ? now : previous!.windowStart;
  if (count > rule.max) {
    const lockedUntil = new Date(now.getTime() + rule.lockMs);
    return { allowed: false, state: { count, windowStart, lockedUntil }, retryAfterMs: rule.lockMs };
  }
  return { allowed: true, state: { count, windowStart, lockedUntil: null }, retryAfterMs: 0 };
}

export function rateLimitKey(kind: "email" | "ip", value: string) {
  // Store only a hash so the table never holds raw emails or IPs.
  return kind + ":" + createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/** Consume one attempt for the key; serialized per key with a row lock. */
export async function consumeAttempt(key: string, rule: LimitRule, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "AuthRateLimit" ("key", "count", "windowStart", "updatedAt") VALUES (${key}, 0, ${now}, ${now}) ON CONFLICT ("key") DO NOTHING`;
    const rows = await tx.$queryRaw<LimitState[]>`SELECT "count", "windowStart", "lockedUntil" FROM "AuthRateLimit" WHERE "key" = ${key} FOR UPDATE`;
    const previous = rows[0] && rows[0].count > 0 ? rows[0] : null;
    const decision = nextLimitState(previous, rule, now);
    await tx.authRateLimit.update({ where: { key }, data: decision.state });
    return decision;
  });
}

export async function clearAttempts(key: string) {
  await db.authRateLimit.deleteMany({ where: { key } });
}
