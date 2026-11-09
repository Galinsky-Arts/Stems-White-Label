import type { Prisma, StripeWebhookScope } from "@prisma/client";

import { db } from "./db";

// The event marker and database effects commit together. A crash or handler
// failure rolls both back; Stripe can retry instead of losing fulfillment.
export async function processStripeWebhookOnce(
  scope: StripeWebhookScope,
  event: { id: string; type: string },
  process: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  return db.$transaction(async (tx) => {
    // A hash collision merely serializes unrelated events. Values are parameters.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ":" + event.id}, 0))::text`;
    const existing = await tx.stripeWebhookEvent.findUnique({
      where: { scope_providerEventId: { scope, providerEventId: event.id } },
    });
    if (existing) return { duplicate: true };
    await process(tx);
    await tx.stripeWebhookEvent.create({
      data: { scope, providerEventId: event.id, eventType: event.type },
    });
    return { duplicate: false };
  }, { timeout: 30000, maxWait: 5000 });
}
