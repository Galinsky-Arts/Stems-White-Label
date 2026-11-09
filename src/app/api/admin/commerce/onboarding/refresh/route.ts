import { redirect } from "next/navigation";

import { checkoutReturnOrigin } from "@/lib/checkout-origin";
import { db } from "@/lib/db";
import { onboardingRefreshAllowed } from "@/lib/commerce";
import { getTenantApiAccess } from "@/lib/access";
import { createConnectedAccountOnboardingLink } from "@/lib/stripe-connect";

export async function GET(request: Request) {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) redirect("/auth/sign-in?callbackUrl=/admin/commerce");

  const commerce = await db.tenantCommerce.findUnique({ where: { tenantId: access.tenant.id } });
  if (!onboardingRefreshAllowed(commerce)) redirect("/admin/commerce");
  const origin = checkoutReturnOrigin(request.url, request.headers.get("host"), process.env.NODE_ENV === "production");
  const url = await createConnectedAccountOnboardingLink({
    tenantId: access.tenant.id,
    email: access.session.user?.email ?? null,
    origin,
  });

  redirect(url);
}
