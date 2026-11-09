import Link from "next/link";

import { requirePlatformSuperAdmin } from "@/lib/platform-access";
import {
  getPlatformOverview,
  getPlatformTenantList,
} from "@/lib/platform-admin";

function countFor(
  rows: Array<{ status: string; _count: { _all: number } }>,
  status: string,
) {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

function bytes(value: bigint) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = Number(value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return amount.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " " + units[index];
}

function money(cents: bigint, currency: string) {
  const amount = Number(cents) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return currency + " " + amount.toFixed(2);
  }
}

function commerceReady(commerce: {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
} | null) {
  return Boolean(
    commerce?.stripeAccountId &&
      commerce.chargesEnabled &&
      commerce.payoutsEnabled &&
      commerce.detailsSubmitted &&
      !commerce.disabledReason,
  );
}

export default async function PlatformAdminPage() {
  const access = await requirePlatformSuperAdmin();
  const [overview, tenants] = await Promise.all([
    getPlatformOverview(),
    getPlatformTenantList(),
  ]);

  const activeTenants = countFor(overview.tenantStatuses, "ACTIVE");
  const suspendedTenants = countFor(overview.tenantStatuses, "SUSPENDED");
  const failedAudio = countFor(overview.processingStatuses, "FAILED");
  const failedPackages = countFor(overview.packageStatuses, "FAILED");

  return (
    <main className="cms-shell platform-admin-shell">
      <header className="platform-admin-header">
        <div>
          <p className="eyebrow">Platform super admin</p>
          <h1>Stems White Label</h1>
          <Link href="/platform-admin/operations">Worker and deployment health</Link>
          <p>
            Signed in as {access.user.email ?? access.user.name ?? access.user.id}.
            This control plane spans tenants; tenant-admin permissions do not grant
            access here.
          </p>
        </div>
      </header>

      <section className="platform-kpis">
        <article>
          <span>Active tenants</span>
          <strong>{activeTenants.toLocaleString()}</strong>
          <small>{suspendedTenants.toLocaleString()} suspended</small>
        </article>
        <article>
          <span>Stored objects</span>
          <strong>{bytes(overview.storage.totalBytes)}</strong>
          <small>Tracked application storage</small>
        </article>
        <article>
          <span>Domain readiness</span>
          <strong>
            {overview.domains.ready.toLocaleString()} / {overview.domains.total.toLocaleString()}
          </strong>
          <small>{overview.domains.failed.toLocaleString()} failed checks</small>
        </article>
        <article>
          <span>Connect ready</span>
          <strong>
            {overview.commerce.ready.toLocaleString()} / {overview.commerce.total.toLocaleString()}
          </strong>
          <small>Charges + payouts + details ready</small>
        </article>
        <article>
          <span>Failed jobs</span>
          <strong>{(failedAudio + failedPackages).toLocaleString()}</strong>
          <small>{failedAudio} audio · {failedPackages} package</small>
        </article>
        <article>
          <span>Signed delivery requests</span>
          <strong>
            {(overview.deliveryRequests.directCount + overview.deliveryRequests.packageCount).toLocaleString()}
          </strong>
          <small>
            {bytes(
              overview.deliveryRequests.directBytesRequested +
                overview.deliveryRequests.packageBytesRequested,
            )} requested
          </small>
        </article>
      </section>

      <div className="platform-overview-grid">
        <section className="cms-panel">
          <div className="cms-panel__heading">
            <p className="eyebrow">Storage posture</p>
            <h2>Tracked bytes</h2>
            <p>
              Application-recorded object sizes. This is not a substitute for the
              object-storage provider&apos;s billable usage meter.
            </p>
          </div>
          <dl className="platform-metric-list">
            <dt>Audio</dt><dd>{bytes(overview.storage.audioBytes)}</dd>
            <dt>Artwork</dt><dd>{bytes(overview.storage.artworkBytes)}</dd>
            <dt>Theme assets</dt><dd>{bytes(overview.storage.themeBytes)}</dd>
            <dt>Generated ZIP packages</dt><dd>{bytes(overview.storage.packageBytes)}</dd>
          </dl>
        </section>

        <section className="cms-panel">
          <div className="cms-panel__heading">
            <p className="eyebrow">Delivery activity</p>
            <h2>Signed download requests</h2>
            <p>
              Bytes are requested-object sizes multiplied by signed-download
              requests. They are useful operational demand metrics, not exact CDN
              egress or proof that the recipient downloaded every byte.
            </p>
          </div>
          <dl className="platform-metric-list">
            <dt>Original-file requests</dt>
            <dd>{overview.deliveryRequests.directCount.toLocaleString()}</dd>
            <dt>Original bytes requested</dt>
            <dd>{bytes(overview.deliveryRequests.directBytesRequested)}</dd>
            <dt>ZIP-package requests</dt>
            <dd>{overview.deliveryRequests.packageCount.toLocaleString()}</dd>
            <dt>ZIP bytes requested</dt>
            <dd>{bytes(overview.deliveryRequests.packageBytesRequested)}</dd>
          </dl>
        </section>
      </div>

      <section className="cms-panel">
        <div className="cms-panel__heading">
          <p className="eyebrow">30-day customer payments</p>
          <h2>Platform commerce volume</h2>
        </div>
        {overview.payments30d.length ? (
          <div className="platform-payment-grid">
            {overview.payments30d.map((row) => (
              <article key={row.currency}>
                <p className="eyebrow">{row.currency}</p>
                <strong>{money(row.netCents, row.currency)}</strong>
                <dl>
                  <dt>Gross</dt><dd>{money(row.grossCents, row.currency)}</dd>
                  <dt>Refunded</dt><dd>{money(row.refundedCents, row.currency)}</dd>
                  <dt>Orders</dt><dd>{row.orders.toString()}</dd>
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <p className="cms-empty">No paid customer orders in the last 30 days.</p>
        )}
      </section>

      <section className="cms-panel">
        <div className="cms-panel__heading">
          <p className="eyebrow">Tenants</p>
          <h2>Operating estate</h2>
        </div>
        <div className="analytics-table-wrap">
          <table className="analytics-table platform-tenant-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Status</th>
                <th>SaaS plan</th>
                <th>Connect</th>
                <th>Storage</th>
                <th>Works</th>
                <th>Members</th>
                <th>Domains</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <Link href={"/platform-admin/tenants/" + tenant.id}>
                      {tenant.name}
                    </Link>
                    <small>{tenant.slug}</small>
                  </td>
                  <td>{tenant.status}</td>
                  <td>
                    {tenant.subscription?.planName ??
                      tenant.subscription?.status ??
                      "No subscription"}
                  </td>
                  <td>
                    {commerceReady(tenant.commerce)
                      ? "Ready"
                      : tenant.commerce?.stripeAccountId
                        ? "Restricted"
                        : "Not connected"}
                  </td>
                  <td>{bytes(tenant.storageBytes)}</td>
                  <td>{tenant._count.works}</td>
                  <td>{tenant._count.memberships}</td>
                  <td>{tenant._count.domains}</td>
                  <td>{tenant._count.featureFlags}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="platform-overview-grid">
        <section className="cms-panel">
          <div className="cms-panel__heading">
            <p className="eyebrow">Recent audio failures</p>
            <h2>Processing errors</h2>
          </div>
          {overview.recentFailures.length ? (
            <div className="platform-failures">
              {overview.recentFailures.map((job) => (
                <article key={job.id}>
                  <div>
                    <strong>{job.audioAsset.fileName}</strong>
                    <span>{job.tenant.name}</span>
                    {job.lastError ? <p>{job.lastError}</p> : null}
                  </div>
                  <Link
                    className="text-link"
                    href={"/platform-admin/tenants/" + job.tenantId}
                  >
                    Inspect
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <p className="cms-empty">No failed audio jobs.</p>
          )}
        </section>

        <section className="cms-panel">
          <div className="cms-panel__heading">
            <p className="eyebrow">Recent package failures</p>
            <h2>Delivery errors</h2>
          </div>
          {overview.recentPackageFailures.length ? (
            <div className="platform-failures">
              {overview.recentPackageFailures.map((entry) => (
                <article key={entry.id}>
                  <div>
                    <strong>{entry.fileName}</strong>
                    <span>{entry.tenant.name}</span>
                    {entry.lastError ? <p>{entry.lastError}</p> : null}
                  </div>
                  <Link
                    className="text-link"
                    href={"/platform-admin/tenants/" + entry.tenantId}
                  >
                    Inspect
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <p className="cms-empty">No failed ZIP package jobs.</p>
          )}
        </section>
      </div>

      <section className="cms-panel">
        <div className="cms-panel__heading">
          <p className="eyebrow">Operator activity</p>
          <h2>Immutable audit ledger</h2>
        </div>
        {overview.recentAudit.length ? (
          <div className="platform-audit-list">
            {overview.recentAudit.map((row) => (
              <article key={row.id}>
                <time>{row.createdAt.toLocaleString()}</time>
                <strong>{row.action}</strong>
                <span>
                  {row.actorEmail ?? row.actorUserId ?? "System"} ·{" "}
                  {row.tenant?.name ?? row.targetType}
                </span>
                {row.reason ? <p>{row.reason}</p> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="cms-empty">No platform mutations have been recorded yet.</p>
        )}
      </section>
    </main>
  );
}
