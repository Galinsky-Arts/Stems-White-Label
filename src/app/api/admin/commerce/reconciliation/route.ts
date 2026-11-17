import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  listOrdersNeedingReconciliation,
  requestCanceledOrderRefund,
  resolveCanceledOrderPayment,
} from "@/lib/payment-reconciliation";

export async function GET() {
  const access = await getTenantApiAccess("finance.read");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const orders = await listOrdersNeedingReconciliation(access.tenant.id);
  return NextResponse.json({ orders }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  // Moving money or closing a review requires tenant management rights.
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => null);
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  const action = String(body?.action ?? "");
  try {
    if (action === "refund") {
      await requestCanceledOrderRefund(access.tenant.id, orderId);
    } else if (action === "resolve") {
      await resolveCanceledOrderPayment(access.tenant.id, orderId, String(body?.note ?? ""));
    } else {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
    }
    return NextResponse.json({ orders: await listOrdersNeedingReconciliation(access.tenant.id) });
  } catch (error) {
    const message = error instanceof Error && /awaiting|no captured|note is required|STRIPE_SECRET_KEY/.test(error.message)
      ? error.message
      : "Reconciliation action failed.";
    if (message === "Reconciliation action failed.") console.error("Reconciliation action failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
