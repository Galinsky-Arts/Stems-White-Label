import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { quoteLicenseProducts } from "@/lib/checkout";
import { commerceReadiness } from "@/lib/commerce";
import { db } from "@/lib/db";
import { getCurrentTenant } from "@/lib/tenant";

export async function POST(request: Request) {
  const tenant = await getCurrentTenant();
  if (!tenant) return NextResponse.json({ error: "Storefront not found." }, { status: 404 });

  const body = await request.json().catch(() => null);
  try {
    const [quote, commerce] = await Promise.all([
      quoteLicenseProducts(tenant.id, body?.licenseProductIds),
      db.tenantCommerce.findUnique({ where: { tenantId: tenant.id } }),
    ]);
    const checkoutReady = commerce ? commerceReadiness(commerce).ready : false;

    return NextResponse.json({
      checkoutReady,
      currency: quote.currency,
      subtotalCents: quote.subtotalCents,
      items: quote.items.map((item) => ({
        licenseProductId: item.licenseProductId,
        licenseVersionId: item.licenseVersionId,
        workSlug: item.workSlug,
        workTitle: item.workTitle,
        licenseName: item.licenseName,
        licenseVersionNumber: item.licenseVersionNumber,
        scope: item.scope,
        priceCents: item.priceCents,
        currency: item.currency,
        termsText: item.termsText,
        selectedStemLabels: item.selectedStemLabels,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to quote cart.") },
      { status: 400 },
    );
  }
}
