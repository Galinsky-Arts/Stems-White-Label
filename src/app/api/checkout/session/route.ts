import { publicOperationError } from "@/lib/public-operation-error";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

import {
  ANALYTICS_SESSION_COOKIE,
  normalizeAnalyticsSessionId,
  recordSystemAnalyticsEvent,
} from "@/lib/analytics";
import { checkoutReturnOrigin } from "@/lib/checkout-origin";
import {
  assertAcceptedLicenseVersions,
  createPendingOrder,
  normalizeBuyerEmail,
  quoteLicenseProducts,
} from "@/lib/checkout";
import { getTenantCommerceForCheckout } from "@/lib/commerce";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { getCurrentTenant } from "@/lib/tenant";

export async function POST(request: Request) {
  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: "Storefront not found." }, { status: 404 });

  const body = await request.json().catch(() => null);

  try {
    const hostHeader = (await headers()).get("host");
    const origin = checkoutReturnOrigin(request.url, hostHeader, process.env.NODE_ENV === "production");
    const quote = await quoteLicenseProducts(tenant.id, body?.licenseProductIds);
    assertAcceptedLicenseVersions(quote, body?.acceptedLicenseVersionIds);

    const buyerEmail = normalizeBuyerEmail(body?.buyerEmail);
    const commerce = await getTenantCommerceForCheckout(
      tenant.id,
      quote.subtotalCents,
    );
    const order = await createPendingOrder(
      tenant.id,
      quote,
      body?.termsAccepted === true,
      buyerEmail,
      {
        stripeConnectedAccountId: commerce.stripeAccountId,
        platformFeeCents: commerce.platformFeeCents,
      },
    );

    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
        customer_email: buyerEmail ?? undefined,
        success_url: origin + "/checkout/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: origin + "/cart?canceled=1",
        metadata: {
          orderId: order.id,
          tenantId: tenant.id,
          stripeConnectedAccountId: commerce.stripeAccountId,
          platformFeeCents: String(commerce.platformFeeCents),
        },
        payment_intent_data: {
          receipt_email: buyerEmail ?? undefined,
          application_fee_amount:
            commerce.platformFeeCents > 0
              ? commerce.platformFeeCents
              : undefined,
          transfer_data: {
            destination: commerce.stripeAccountId,
          },
          transfer_group: "order_" + order.id,
          metadata: {
            orderId: order.id,
            tenantId: tenant.id,
            stripeConnectedAccountId: commerce.stripeAccountId,
            platformFeeCents: String(commerce.platformFeeCents),
          },
        },
        line_items: quote.items.map((item) => ({
          quantity: 1,
          price_data: {
            currency: item.currency.toLowerCase(),
            unit_amount: item.priceCents,
            product_data: {
              name: item.workTitle + " — " + item.licenseName,
              description: "License version " + item.licenseVersionNumber,
              metadata: {
                licenseProductId: item.licenseProductId,
                licenseVersionId: item.licenseVersionId,
              },
            },
          },
        })),
      });

      if (!session.url) throw new Error("Stripe did not return a checkout URL.");

      await db.order.update({
        where: { id: order.id },
        data: {
          status: "CHECKOUT_CREATED",
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId:
            typeof session.payment_intent === "string" ? session.payment_intent : undefined,
        },
      });

      const cookieStore = await cookies();
      const analyticsSession = cookieStore.get(ANALYTICS_SESSION_COOKIE)?.value;
      await recordSystemAnalyticsEvent({
        tenantId: tenant.id,
        type: "CHECKOUT_STARTED",
        orderId: order.id,
        sessionId: analyticsSession
          ? normalizeAnalyticsSessionId(analyticsSession)
          : null,
      }).catch((analyticsError) => {
        console.error("Unable to record checkout analytics");
      });

      return NextResponse.json({ url: session.url, orderId: order.id });
    } catch (stripeError) {
      await db.order.update({
        where: { id: order.id },
        data: { status: "CANCELED", canceledAt: new Date() },
      }).catch(() => undefined);
      throw stripeError;
    }
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to start checkout.") },
      { status: 400 },
    );
  }
}
