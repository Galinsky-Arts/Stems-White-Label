import Stripe from "stripe";
import { readWebhookBody } from "@/lib/webhook-body";
import { NextResponse } from "next/server";

import { processStripeWebhookOnce } from "@/lib/stripe-webhook";
import {
  persistTenantCommerceAccount,
  stripeAccountSnapshot,
} from "@/lib/commerce";
import {
  getStripe,
  getStripeConnectWebhookSecret,
} from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Stripe signature." },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readWebhookBody(request);
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      getStripeConnectWebhookSecret(),
    );
  } catch {
    return NextResponse.json({ error: "Invalid Stripe Connect webhook." }, { status: 400 });
  }

  try {
    const result = await processStripeWebhookOnce("CONNECT", event, async (tx) => {
      if (event.type !== "account.updated") return;
      const account = event.data.object as Stripe.Account;
      const commerce = await tx.tenantCommerce.findUnique({ where: { stripeAccountId: account.id }, select: { tenantId: true } });
      if (!commerce) return;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"connect:" + commerce.tenantId}, 0))::text`;
      // Read current provider state after serialization; old event snapshots cannot
      // overwrite a newer account restriction/readiness update.
      const current = await getStripe().accounts.retrieve(account.id);
      if (current.deleted) throw new Error("Connected account is deleted.");
      await persistTenantCommerceAccount(commerce.tenantId, stripeAccountSnapshot(current), tx);
    });
    return NextResponse.json({ received: true, ...result });
  } catch {
    console.error("Stripe Connect webhook processing failed");
    return NextResponse.json({ error: "Connect webhook processing failed." }, { status: 500 });
  }
}
