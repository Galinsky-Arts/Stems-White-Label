# Stems release verification — November 9, 2026

Stripe remains the approved payment provider by the owner's instruction on November 9. Issue #28 and replacement-gateway PR #35 are superseded as implementation direction; their code is not part of this release.

This release consolidates security work from #36, worker/deployment monitoring from #37, and bounded private-storage URLs from #40. The existing source also provides the webhook error redaction requested in #38 and strict Host parsing requested in #39. Consolidation fixes the platform-admin projection, release identity typing, and the incident API's origin comparison under Next.js. Source implementation and local tests do not imply production commercial acceptance.

## Verified locally

- All 17 migrations applied to isolated PostgreSQL 17.
- 138 unit tests, all 16 integration suites, TypeScript, and production build passed.
- Signed offline Stripe payment/Connect/billing fixtures cover duplicate and concurrent delivery, rollback, failed and out-of-order events, immutable amounts/buyers, refunds and revoked licenses.
- Built-server browser acceptance uses two tenants, synthetic audio, a local S3 emulator and real supervised asset/package worker processes inside the web instance. It verifies desktop/mobile WCAG A/AA checks, playback/mute/keyboard seek/resume, public preview range requests, signed fixture payment fulfillment/replay, authenticated original-file checksum, actual ZIP/license construction, and refund revocation of file/package access.
- Production dependency audit reports zero vulnerabilities after updating Nodemailer and transitive deepmerge/minimatch. The lockfile and npm ci make the checked dependency tree repeatable.
- Portable Node 22 container builds and includes FFmpeg, ffprobe, Prisma and the TypeScript worker runner. It runs as an unprivileged user, forwards termination through dumb-init, respects PORT and does not migrate on restart.

The S3 emulator and signed offline Stripe fixtures are not real merchant/provider acceptance. Automated accessibility checks cover the work page at 1440px and 390px; they do not constitute a complete human accessibility audit. Browser sessions in tests are synthetic database sessions, not an external OAuth/SMTP sign-in exercise.

## Reproduce browser acceptance

Use a fresh, isolated local PostgreSQL database with migrations applied. Run a local Moto S3 server on port 9000. Configure OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000, synthetic access/secret keys, and OBJECT_STORAGE_FORCE_PATH_STYLE=true. Install Chromium with `npx playwright install --with-deps chromium`, build the application and run `npm run test:browser-integration`.

The test refuses remote database/storage hosts. It creates and removes only its unique fixtures. It requires unused localhost and 127.0.0.1 tenant domains, FFmpeg, unzip and a free port 3100. Set STEMS_BROWSER_PORT to override the port. CI runs it after the existing integrations and production build.

## Provider and commercial acceptance

Target organizations are Render tea-dbp1vrrl550s73c3dgrg and Neon org-red-surf-69664431. These were empty when authorized access was restored. A free Neon project and private bucket have been created; deployment evidence is recorded separately once verified.

Still required before selling real music: actual authorized flagship masters/stems and legal offerings; working OAuth and customer SMTP; Stripe platform keys plus separate Checkout/Connect/Billing webhook secrets, seller onboarding and test-mode purchase/refund acceptance; deployed durable workers, external alert receipt and a production backup/restore exercise. No paid resources or real card charges are authorized by this record. Independent human security review remains deferred follow-up under AGENTS.md.

## Free deployment decision

The owner declined paid worker subscriptions. The unused paid Blueprint source
was removed; its planning attempt created no resources. The free native Node
service now supports integrated supervised workers using static FFmpeg/ffprobe
fallbacks. Browser acceptance runs through this exact integrated topology.
Job leases renew during processing and stale recovery repeats after startup,
so interrupted jobs can be recovered even when the host wakes before lease expiry.
Standalone consumer commands remain available for another zero-cost host.

The public repository cannot import the monitoring project's private cross-account
workflow. Its current zero-budget inventory-only policy is validated locally;
this does not enable a monitor, notification channel or failover.
