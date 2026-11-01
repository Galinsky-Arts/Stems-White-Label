import assert from "node:assert/strict";
import test from "node:test";

import { probeDeployment, probeEndpoint, probeOperations } from "./live-smoke.mjs";

const good = (url) => new Response(
  JSON.stringify({
    ok: true,
    service: "stems-white-label",
    ...(url.pathname === "/api/ready" ? { dependencies: { database: "ready" } } : {}),
  }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

test("probes both actual application endpoints, including database readiness", async () => {
  const paths = [];
  const result = await probeDeployment(
    "https://stems-white-label-preview.onrender.com",
    async (url) => { paths.push(url.pathname); return good(url); },
    { attempts: 1 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(paths, ["/api/health", "/api/ready"]);
});

test("an HTML or inaccurate 200 response does not count as healthy", async () => {
  await assert.rejects(
    probeEndpoint(async () => new Response("<h1>OK</h1>", { status: 200 }), "https://example.com", "/api/health"),
  );
  await assert.rejects(
    probeEndpoint(async () => new Response(JSON.stringify({ ok: true, service: "stems-white-label", dependencies: { database: "unavailable" } }), { status: 200 }), "https://example.com", "/api/ready"),
  );
});

test("temporary cold-start failures retry before being considered down", async () => {
  let count = 0;
  const result = await probeDeployment(
    "https://stems-white-label-preview.onrender.com",
    async (url) => ++count === 1 ? new Response("retry", { status: 503 }) : good(url),
    { attempts: 3, delayMs: 0, sleep: async () => {} },
  );
  assert.equal(result.attempts, 2);
});

test("rejects insecure or credential-bearing monitoring destinations", async () => {
  await assert.rejects(probeDeployment("http://example.com", async () => good(new URL("https://example.com"))));
  await assert.rejects(probeDeployment("https://user:pass@example.com", async () => good(new URL("https://example.com"))));
});

test("authenticated operations check sends bearer only to the fixed HTTPS endpoint and rejects redirects", async () => {
  const token = "synthetic-private-monitor-token-".repeat(2);
  let calls = 0;
  const ok = async (url, options) => {
    calls++;
    assert.equal(url.toString(), "https://monitor.example/api/operations");
    assert.equal(options.headers.authorization, "Bearer " + token);
    assert.equal(options.redirect, "manual");
    return new Response(JSON.stringify({ ok: true, service: "stems-white-label", alerts: [], observedAt: new Date().toISOString() }));
  };
  await probeOperations(ok, "https://monitor.example/path", token);
  assert.equal(calls, 1);
  for (const base of ["http://monitor.example", "https://user:pass@monitor.example", "https://monitor.example?token=private"]) {
    await assert.rejects(probeOperations(ok, base, token));
  }
  assert.equal(calls, 1);
  for (const status of [302, 401, 503]) {
    await assert.rejects(probeOperations(async () => new Response(null, { status }), "https://monitor.example", token), /not healthy/);
  }
});
test("operations probe rejects stale data and alerts even behind a successful HTTP proxy", async () => {
  const token = "synthetic-private-monitor-token-".repeat(2);
  for (const data of [
    { ok: true, service: "stems-white-label", alerts: [{ key: "ASSET_WORKER_MISSING" }], observedAt: new Date().toISOString() },
    { ok: true, service: "stems-white-label", alerts: [], observedAt: "2000-01-01T00:00:00Z" },
    { ok: true, service: "stems-white-label", alerts: [], observedAt: "not-a-date" },
    { ok: true, service: "other", alerts: [], observedAt: new Date().toISOString() },
  ]) await assert.rejects(probeOperations(async () => new Response(JSON.stringify(data)), "https://monitor.example", token));
});
