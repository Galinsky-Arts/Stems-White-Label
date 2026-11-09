# Production deployment and Engine Room integration

This is a deployment **runbook**, not evidence of an active production deployment.
Never commit live credentials or allow demo catalog material to become production data.

## Current free Galinsky Arts deployment

The owner requires a zero-cost deployment. The Render Free web service runs the
web application plus supervised asset/package consumers when
`STEMS_INTEGRATED_WORKERS=true`. Static FFmpeg/ffprobe packages supply media tools
on the native Node runtime. Private media stays in the Neon bucket; jobs and
worker observations stay in Postgres. Worker crashes restart with bounded backoff,
active leases renew, and stale jobs are recovered periodically after a restart.
No paid worker resources are required or activated.

A free Render instance sleeps after inactivity, which also pauses processing.
New traffic wakes the web service and consumers. Catalog/package polling keeps an
active browser flow running; this is not independent always-on worker capacity.
For this deployment set both worker poll intervals to 5000 ms and stale-lock
thresholds to two minutes. Active lease renewal prevents valid long jobs expiring.
The free quotas for web/DB/storage still apply. Upgrading is an owner decision.

The target web service is `stems-galinsky-arts`, in Render workspace
`tea-dbp1vrrl550s73c3dgrg`. The Neon project is `snowy-glitter-47676908` in
`org-red-surf-69664431`, with production branch `br-icy-union-bbsc8w83` and private
bucket `stems-private`. Never copy credentials into source or this document.

## Components for larger deployments

Deploy **three processes from the same commit** with Node.js 22, a private
PostgreSQL instance, and an S3-compatible **private** object bucket:

1. **Web**: `npm install && npm run build`, followed by
   `npm run db:deploy && npm run start` (ensure only one deploy/migration actor).
2. **Asset worker**: `npm install && npm run worker:assets` with FFmpeg and
   ffprobe binaries installed and available on PATH.
3. **Package worker**: `npm install && npm run worker:packages`.
   Container filesystem is ephemeral; workers must use private object storage.

All three processes share `DATABASE_URL` and object-storage configuration.
Separate the workers from the HTTP instance to prevent audio processing from
starving requests. For production builds, favor a pinned Node release and
committed package lock. Do not enable paid services without explicit approval.

## Configuration and cutover

* Provision database and object storage, configure `.env.example` values as
  **private service environment variables**, never in a client bundle.
* On the platform-owned Render hostname only, set `PLATFORM_DEFAULT_HOSTNAME=stems-white-label-preview.onrender.com` and `DEFAULT_TENANT_SLUG=unsealed-records` as server environment variables. Without this exact host setting, the shared preview hostname cannot resolve a tenant when `TenantDomain` has no verified domain rows. This narrow fallback is intentionally separate from customer custom domain verification. Do not configure unowned hostnames or wildcard values here.
* Configure NextAuth GitHub OAuth, production `NEXTAUTH_URL` and
  `NEXTAUTH_SECRET`, customer SMTP, private upload bucket CORS, Stripe
  Checkout/Connect/Billing webhook endpoints and *separate signing secrets*.
* Configure custom-domain routing targets, verify domain ownership, route and
  HTTPS readiness through tenant administration. DNS/certificate provisioning
  remains a hosting-provider task.
* Apply all Prisma migrations once with `npm run db:deploy`. Seed the intended
  tenant only after reviewing tenant/user memberships. Keep `DEMO_MODE=false`
  on customer-facing production domains unless explicitly demonstrating.
* Before enabling live commerce, validate seller onboarding, tax/refund and
  subscription posture, signed webhook processing, real download entitlements,
  order/license immutability, and a refund/revocation dry run.
* Smoke-test uploads, previews, a synchronized multistem audition, license
  acceptance, completed payment, customer library and timed download.
* Configure daily offsite database backups, periodic restore exercises,
  object-storage retention, and webhook reconciliation alerting.

## Probes

* `GET /api/health`: process liveness, HTTP 200 (not a dependency check).
* `HEAD /api/health`: lightweight liveness.
* `GET /api/ready`: database readiness; HTTP 200 when available, HTTP 503
  when unavailable or a check exceeds three seconds. The response is
  deliberately non-sensitive and bypasses caching.
* Monitor the above from Engine Room with service, environment and URL fields.
  Avoid recording headers, tokens, customer identity, or webhook payloads.

## Engine Room telemetry contract

Suggested non-secret periodic data fields: `service_id`, `environment`,
`commit_sha`, `deployment_state`, `last_probe_at`, `http_status`,
`latency_ms`, `worker_role`, `queue_pending`, `queue_failed`,
`last_job_completed_at`, `last_ci_conclusion`.

Publish from **trusted server-side** monitoring; do not put GitHub or hosting
credentials into a storefront endpoint. Engine Room should poll the real
deployment and GitHub APIs, not treat a static `ok` response as proof of
end-to-end checkout or worker health. Queue counters require authenticated
internal telemetry or read-only DB access with appropriately scoped credentials.

## Rollback

Retain previous healthy image/commit, track migration compatibility, disable
checkout first if payment reconciliation is impaired, and roll back the web
service only when database changes are backward compatible. Do not reverse
irreversible schema/data migrations automatically.
