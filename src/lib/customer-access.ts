import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "@/lib/auth";
import { resolveCustomerForIdentity } from "@/lib/customer-identity";
import { getCurrentTenant } from "@/lib/tenant";

export async function resolveCustomerForSession() {
  const [tenant, session] = await Promise.all([
    getCurrentTenant(),
    getServerSession(authOptions),
  ]);

  if (!tenant || !session?.user?.id) {
    return { tenant, session, customer: null };
  }

  const customer = await resolveCustomerForIdentity(tenant.id, session.user.id);

  return { tenant, session, customer };
}

export async function requireCustomerAccount() {
  const resolved = await resolveCustomerForSession();

  if (!resolved.tenant) {
    throw new Error("No active tenant resolved for this hostname.");
  }

  if (!resolved.session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/library");
  }

  return { ...resolved, customer: resolved.customer };
}

export async function getCustomerApiAccess() {
  const resolved = await resolveCustomerForSession();
  if (!resolved.tenant || !resolved.session?.user?.id || !resolved.customer) {
    return null;
  }
  return { ...resolved, customer: resolved.customer };
}
