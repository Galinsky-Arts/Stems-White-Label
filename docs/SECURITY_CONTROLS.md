# SWL-24 security controls and verification

This records implementation and reproducible tests, not an independent audit, certification, or production deployment acceptance. Synthetic test sessions, keys, accounts, events and media are fixtures. No test creates a provider account, charges a card, or calls a provider write API.

## Controls

| Boundary | Implemented control | Verification |
| --- | --- | --- |
| Tenant routing | One parsed Host; reject lists, URL syntax and malformed DNS labels; development localhost fallback is disabled in production | `request-host.test.ts`, existing domain integration, authenticated HTTP fixture |
| Privileged API writes | Exact same-origin gate for admin, platform-admin, team and library mutations; NextAuth retains its CSRF handling and webhooks retain signatures | `mutation-origin.test.ts`, `proxy.test.ts`, authenticated HTTP fixture |
| Sessions and purchase identity | Database sessions expire after 24 hours and refresh at one hour; new customer links require stored verified email and compare-and-set; GitHub email proof comes from its verified email list, invitation acceptance checks the stored identity, and email-bootstrap admin access requires verification | `github-identity.test.ts`, `validate-team-accounts.ts`, `validate-secure-delivery.ts`, authenticated HTTP fixture |
| Checkout fulfillment | Validate recorded session, tenant, amount, currency, mode and paid status before granting rights | `payment-policy.test.ts`, signed route integration in `validate-checkout-orders.ts` |
| Payment state | Lock order rows; fulfillment cannot regress refunds, change an existing purchaser or revive revoked licenses; refunds cannot exceed payment or change their recorded amount/order | Concurrent success/refund/replay and negative database integration tests |
| Webhook delivery | Signature verification over bounded raw UTF-8 input; body read deadline; event marker and database effects share a transaction | `webhook-body.test.ts`, `stripe-webhook-route.test.ts`, signed payment/Billing/Connect database fixtures |
| Billing and Connect | Serialize tenant updates, read current provider snapshots, retain strict customer/session binding and atomic event markers | `validate-webhook-security.ts` with offline provider reads, signed concurrent retries and rollback assertions |
| Domain TLS checks | Reject private, local, link-local, transition and documentation addresses; reject mixed DNS answers; pin validated public IP while retaining original SNI/certificate hostname | `public-address.test.ts` and source review of `verifyDomainTls` |
| Media workers | Allow supported standalone containers and file/pipe protocols; disallow streaming manifests; bound stdout/stderr and execution time; omit raw child-process diagnostics from errors | Actual FFmpeg success and disguised-HLS tests; command overflow/deadline tests |
| Object storage and media response types | Upload signatures bind Content-Type and Content-Length; object metadata cannot serve active HTML, script or SVG through media routes | `upload-signature.test.ts`, `object-content-type.test.ts` |
| Public errors and logs | Fixed application validation allowlist; fixed fallback for arbitrary database/provider exceptions; disable raw Prisma production logging; strip exception objects from accepted API paths and worker logs; persist only fixed job diagnostics | `public-operation-error.test.ts`, signed invalid/tampered webhook tests |

Media process execution defaults to 15 minutes, configurable by `MEDIA_PROCESS_TIMEOUT_MS` with a 30-minute hard ceiling. Provider SDK requests have a five-second request timeout and at most one network retry. Webhook database transactions have a 30-second execution bound.

A refund that arrives before checkout fulfillment resolves the authenticated provider intent metadata. If its order is still unpaid or its payment association is not yet committed, the route fails without an event marker, allowing the provider retry to apply the refund later.

## Reproduce

Use an isolated PostgreSQL database and the repository's documented local dependencies, including FFmpeg. Run migrations, `npm test`, `npm run typecheck`, `npm run test:checkout-integration`, and `npm run test:delivery-integration`. The checkout integration includes signed offline provider fixtures and an isolated HTTP application. The HTTP fixture verifies real database session cookies, tenant-specific catalog reads, wrong-tenant and missing-session denials, viewer write denial, same-origin rejection and preview tenant scoping. Existing CI also runs the remaining database/media integrations and the production build.

The HTTP fixture uses `node:http` to preserve virtual Host headers: native fetch replaces a supplied Host with the URL authority. It uses synthetic database sessions, checks expired and revoked sessions, and verifies that even a signed token cannot expose a MASTER through the PREVIEW route.

Local execution can use `node --import tsx --test src/**/*.test.ts` where the tsx CLI's Unix IPC endpoint is unavailable. CI runs the ordinary npm command. A passing local test is not evidence of a production provider configuration, customer purchase, private object-store origin, TLS cutover or backup restore; those remain environment-specific acceptance under the corresponding approved units.

## Outstanding gateway restriction

The fenced write gateway returned `INPUT_REJECTED` / `INVALID_ARGUMENT`, message `Invalid repository file path`, for the existing path `src/app/api/admin/works/[workId]/route.ts`. A batch containing bracketed Next.js route paths was rejected, while ordinary source paths were accepted. No alternate connector, endpoint, encoding, or renamed route was used.

Pending diagnostic/log redaction edits in dynamic routes remain uncommitted. They cover collection/work/license/domain mutations, upload/verification routes, protected package requests, and public artwork/audio delivery logs. Keep PR #36 draft until that restriction is resolved and the remaining source changes and tests are verified. The other implemented controls and their tests can be reviewed independently in the same PR. Do not interpret green CI as completion of the rejected edits.
