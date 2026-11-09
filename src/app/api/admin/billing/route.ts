import { checkoutReturnOrigin } from "@/lib/checkout-origin";
import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  getTenantBillingState,
  listBillingPlans,
} from "@/lib/billing";
import {
  createSaasCheckoutSession,
  createSaasPortalSession,
  refreshTenantStripeSubscription,
} from "@/lib/stripe-billing";

function serializeState(state: Awaited<ReturnType<typeof getTenantBillingState>>) {
  return {
    subscription: {
      ...state.subscription,
      maxStorageBytes:
        state.subscription.maxStorageBytes == null
          ? null
          : state.subscription.maxStorageBytes.toString(),
    },
    usage: {
      ...state.usage,
      storageBytes: state.usage.storageBytes.toString(),
    },
    access: state.access,
  };
}

function serializePlans(plans: Awaited<ReturnType<typeof listBillingPlans>>) {
  return plans.map((plan) => ({
    ...plan,
    maxStorageBytes:
      plan.maxStorageBytes == null ? null : plan.maxStorageBytes.toString(),
  }));
}

export async function GET() {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const [state, plans] = await Promise.all([
      getTenantBillingState(access.tenant.id),
      listBillingPlans(),
    ]);

    return NextResponse.json(
      {
        billing: serializeState(state),
        plans: serializePlans(plans),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          publicOperationError(error, "Unable to load SaaS billing."),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const action = String(body?.action ?? "");
  try {
    const origin = checkoutReturnOrigin(request.url, request.headers.get("host"), process.env.NODE_ENV === "production");
    if (action === "subscribe") {
      const url = await createSaasCheckoutSession({
        tenantId: access.tenant.id,
        tenantName: access.tenant.name,
        email: access.session.user?.email ?? null,
        priceId: String(body?.priceId ?? ""),
        origin,
      });
      return NextResponse.json({ url });
    }

    if (action === "portal") {
      const url = await createSaasPortalSession({
        tenantId: access.tenant.id,
        origin,
      });
      return NextResponse.json({ url });
    }

    if (action === "sync") {
      await refreshTenantStripeSubscription(access.tenant.id);
      const state = await getTenantBillingState(access.tenant.id);
      return NextResponse.json({ billing: serializeState(state) });
    }

    return NextResponse.json(
      { error: "Unsupported billing action." },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          publicOperationError(error, "Unable to update SaaS billing."),
      },
      { status: 400 },
    );
  }
}
