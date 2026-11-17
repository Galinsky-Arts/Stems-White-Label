import Link from "next/link";

import { requireTenantPermission } from "@/lib/access";
import { getPlatformAccess } from "@/lib/platform-access";
import { hasPermission, type TenantRole } from "@/lib/permissions";

export default async function AdminPage() {
  const [{ tenant, membership, session }, platformAccess] =
    await Promise.all([
      requireTenantPermission("catalog.read"),
      getPlatformAccess(),
    ]);

  const canReadFinance = hasPermission(
    membership.role as TenantRole,
    "finance.read",
  );

  return (
    <main className="cms-shell cms-shell--narrow">
      <p className="eyebrow">Tenant administration</p>
      <h1 style={{ fontFamily: "var(--serif)", fontSize: "clamp(3rem, 8vw, 6rem)", fontWeight: 400, marginBottom: 16 }}>
        {tenant.name}
      </h1>
      <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
        Signed in as {session.user?.email ?? session.user?.name}. Role: {membership.role}.{" "}
        <Link className="text-link" href="/account/password">Change password</Link>
      </p>

      {platformAccess ? (
        <section className="cms-panel">
          <p className="eyebrow">Global operations</p>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
            Platform super admin
          </h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Inspect all tenants, subscriptions, storage, jobs, commerce,
            domains, feature flags, and the immutable operator audit ledger.
          </p>
          <Link className="cms-primary-button" href="/platform-admin">
            Open Platform Console
          </Link>
        </section>
      ) : null}

      <section className="cms-panel">
        <p className="eyebrow">Brand & presentation</p>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
          White-label theme
        </h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Manage tenant logo, favicon, typography, palette, density, hero,
          navigation, footer treatment, and storefront theme presets.
        </p>
        <Link className="cms-primary-button" href="/admin/theme">
          Open Theme Engine
        </Link>
      </section>

      <section className="cms-panel">
        <p className="eyebrow">Domains & HTTPS</p>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
          Custom domains
        </h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Register branded hostnames, verify DNS ownership and platform routing,
          confirm TLS readiness, and choose the tenant's primary domain.
        </p>
        <Link className="cms-primary-button" href="/admin/domains">
          Manage Domains
        </Link>
      </section>

      {canReadFinance ? (
        <section className="cms-panel">
          <p className="eyebrow">Commerce & payouts</p>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
            Stripe Connect
          </h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Onboard the tenant merchant account, review payment and payout
            readiness, and inspect platform-fee settlement status.
          </p>
          <Link className="cms-primary-button" href="/admin/commerce">
            Open Commerce
          </Link>
        </section>
      ) : null}

      {hasPermission(membership.role as TenantRole, "members.manage") ? (
        <section className="cms-panel">
          <p className="eyebrow">Team & access</p>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
            Team accounts
          </h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Invite tenant staff, assign roles, revoke access, and review team-access history.
          </p>
          <Link className="cms-primary-button" href="/admin/team">
            Manage Team
          </Link>
        </section>
      ) : null}

      {hasPermission(membership.role as TenantRole, "tenant.manage") ? (
        <section className="cms-panel">
          <p className="eyebrow">Platform subscription</p>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
            SaaS billing
          </h2>
          <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
            Manage the platform plan, trials, upgrades or downgrades, usage
            limits, invoices, and billing details.
          </p>
          <Link className="cms-primary-button" href="/admin/billing">
            Open Billing
          </Link>
        </section>
      ) : null}

      <section className="cms-panel">
        <p className="eyebrow">Performance & behavior</p>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
          Analytics
        </h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          See Work views, listening behavior, Reveal usage, source-group
          interactions, conversion, paid orders, refunds, and top catalog items.
        </p>
        <Link className="cms-primary-button" href="/admin/analytics">
          Open Analytics
        </Link>
      </section>

      <section className="cms-panel">
        <p className="eyebrow">Catalog</p>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: "2.8rem", fontWeight: 400 }}>
          Source-material CMS
        </h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Create Works, manage source groups, upload masters and stems, edit credits
          and editorial material, choreograph Reveal the Record, preview, and publish.
        </p>
        <Link className="cms-primary-button" href="/admin/catalog">
          Open Catalog CMS
        </Link>
      </section>
    </main>
  );
}
