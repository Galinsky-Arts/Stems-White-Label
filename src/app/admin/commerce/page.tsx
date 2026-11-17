import Link from "next/link";

import { CommerceManager } from "@/components/admin/commerce-manager";
import { PaymentReconciliationPanel } from "@/components/admin/payment-reconciliation-panel";
import { requireTenantPermission } from "@/lib/access";
import { hasPermission, type TenantRole } from "@/lib/permissions";

type PageProps = {
  searchParams: Promise<{ onboarding?: string }>;
};

export default async function CommercePage({ searchParams }: PageProps) {
  const [{ tenant, membership }, params] = await Promise.all([
    requireTenantPermission("finance.read"),
    searchParams,
  ]);

  const canManage = hasPermission(
    membership.role as TenantRole,
    "tenant.manage",
  );

  return (
    <main className="cms-shell">
      <Link className="text-link cms-back-link" href="/admin">
        ← Tenant administration
      </Link>

      <header className="cms-dashboard-header">
        <div>
          <p className="eyebrow">Stripe Connect</p>
          <h1>{tenant.name}</h1>
          <p>
            Onboard the tenant merchant account, track payment and payout
            readiness, and inspect the platform-fee settlement configuration.
          </p>
        </div>
      </header>

      <CommerceManager
        canManage={canManage}
        returnedFromOnboarding={params.onboarding === "returned"}
      />

      <PaymentReconciliationPanel canManage={canManage} />
    </main>
  );
}
