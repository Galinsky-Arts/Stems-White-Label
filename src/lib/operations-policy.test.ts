import assert from "node:assert/strict";
import test from "node:test";
import { monitorAuthorized, operationAlerts, releaseIdentity, type QueueMetric } from "./operations-policy";
const now = new Date("2026-11-01T12:00:00Z");
const sha = "a".repeat(40);
const healthy: QueueMetric = { ready: 0, processing: 0, failed24h: 0, completed24h: 2, oldestReadyAt: null, stale: 0, averageDurationMs: 12 };
const input = () => ({
  now, queues: { ASSET: { ...healthy }, PACKAGE: { ...healthy } },
  workers: ["ASSET", "PACKAGE"].map((kind) => ({ kind, lastSeenAt: now, state: "IDLE", releaseSha: sha })),
  releaseSha: sha, expectedSha: sha, registryObservedAt: now.toISOString(),
});
test("healthy idle workers do not generate false queue alerts", () => {
  assert.deepEqual(operationAlerts(input()), []);
});
test("missing, stopped, future-dated and stale heartbeats fail closed", () => {
  for (const workers of [[], [{ kind: "ASSET", state: "STOPPED", lastSeenAt: now, releaseSha: sha }], [{ kind: "ASSET", state: "IDLE", lastSeenAt: new Date(now.getTime() + 1000), releaseSha: sha }], [{ kind: "ASSET", state: "BUSY", lastSeenAt: new Date(now.getTime() - 90001), releaseSha: sha }]]) {
    assert.ok(operationAlerts({ ...input(), workers }).some((a) => a.key === "ASSET_WORKER_MISSING"));
  }
});
test("backlog, failures, locks, deployment and source freshness have separate alerts", () => {
  const value = input();
  value.queues.ASSET = { ...healthy, ready: 1, stale: 1, failed24h: 1, oldestReadyAt: new Date(now.getTime() - 300001) };
  value.releaseSha = "b".repeat(40);
  value.registryObservedAt = "2026-10-01T12:00:00Z";
  const keys = operationAlerts(value).map((a) => a.key);
  for (const key of ["ASSET_LOCK_STALE", "ASSET_QUEUE_DELAY", "ASSET_FAILURES", "ASSET_RELEASE_MISMATCH", "DEPLOYMENT_SOURCE_STALE", "ROADMAP_SOURCE_STALE"]) assert.ok(keys.includes(key));
});
test("monitor access requires an exact configured bearer and validates release provenance", () => {
  const token = "private-test-monitor-token".repeat(2);
  assert.equal(monitorAuthorized("Bearer " + token, token), true);
  for (const header of [null, "Basic " + token, "Bearer wrong", "Bearer " + token + "x"]) assert.equal(monitorAuthorized(header, token), false);
  assert.equal(monitorAuthorized("Bearer short", "short"), false);
  assert.equal(monitorAuthorized("Bearer " + token, undefined), false);
  assert.equal(releaseIdentity({ GIT_SHA: sha }), sha);
  assert.equal(releaseIdentity({ RENDER_GIT_COMMIT: "private/provider/value" }), null);
});
