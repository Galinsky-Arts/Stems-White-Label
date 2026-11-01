# Worker and deployment observability

Apply the additive operations migration before starting the web and both workers.
Deploy all three from the same accepted commit. This runbook is software setup,
not proof that production workers, alert delivery or deployment have been accepted.

Workers persist heartbeats every 15 seconds, including during long-running media
jobs. Graceful shutdown records STOPPED; a crash becomes missing after 90 seconds.
ASSET and PACKAGE are always expected. The monitor reports current eligible queue
depth, processing locks, oldest due job, failures/completions in 24 hours and
average recorded execution duration. Scheduled retries are excluded until due;
exhausted jobs are excluded from ready depth. A stale lock is reported after
20 minutes for assets or 30 minutes for packages. Heartbeat and metric writes
never log raw exceptions or private object names.

## Monitoring and alert delivery

Use GET /api/operations with a private OPERATIONS_MONITOR_TOKEN (at least 32
random characters) as an Authorization Bearer header. Configure it in the
external monitor's secret settings; never put it in a URL or repository.
The token grants read access only. Missing/wrong tokens receive 401 unless
the caller has an authenticated platform administrator session.
The endpoint returns no-store JSON and HTTP 503 for active alerts or unavailable
monitoring. Point the authorized existing monitor at that status and route alerts
through its approved notification channel. No paid monitor or new schedule is
provisioned by this change. Verify actual notification delivery during cutover.

The existing live-smoke runner can include authenticated operations by receiving
STEMS_OPERATIONS_MONITOR_TOKEN from the monitor's private secret settings.
It refuses redirects, stale JSON and any active alerts, including an inaccurate
HTTP 200 proxy response. This source change does not edit any recurring schedule.

The public /api/health and /api/ready remain process and database probes; they do
not expose global tenant queue state or imply workers are healthy.

## Release provenance and Engine Room

Set GIT_SHA to the actual full 40-character deployed commit, or use Render's
RENDER_GIT_COMMIT. Polling records a durable deployment observation of that
running commit, its trusted environment source and observation time. It does not
invent provider deployment success, build time or release approval. Unknown
commit identity is an alert. Optional OPERATIONS_EXPECTED_COMMIT detects a
running release behind Engine Room's accepted commit. Worker/web mismatches also
alert. Keep registry/prs.json mappings and observedAt grounded in actual source
verification; missing/future/older-than-seven-day observation warns independently.
No PR is declared merged by this monitor.

## Incident response

Platform administrators use /platform-admin/operations to inspect alerts and
acknowledge incidents. The incident POST endpoint also accepts alertKey and
action ACKNOWLEDGE or RESOLVE under an authenticated platform session and matching
request Origin. Monitoring tokens cannot acknowledge or resolve incidents.
Actions are recorded in the existing immutable PlatformAuditLog. Resolution is
rejected while the condition remains active; acknowledging never suppresses the
monitor's alerts. Inspect worker processes, queue locks and recent release before
retrying jobs through existing tenant-scoped administrator controls. Preserve
private source objects and payment/entitlement records. After repair, re-probe,
resolve the incident and verify rollback/restore evidence separately.

Worker observations older than 24 hours are excluded from the monitor; raw
observations remain in PostgreSQL for operational retention managed by the owner.
No customer email, asset IDs, storage keys or error text is emitted by this API.
