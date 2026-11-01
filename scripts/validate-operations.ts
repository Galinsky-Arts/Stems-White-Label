import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { getOperationsSnapshot, observeDeployment, recordOperationIncident, startWorkerObservation } from "../src/lib/operations";
import { GET as monitor } from "../src/app/api/operations/route";

export async function validateOperations() {
  const suffix = Date.now().toString(36);
  const previous = { GIT_SHA: process.env.GIT_SHA, RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT, OPERATIONS_MONITOR_TOKEN: process.env.OPERATIONS_MONITOR_TOKEN };
  const sha = "b".repeat(40);
  const token = "synthetic-monitor-test-token-".repeat(2);
  process.env.GIT_SHA = sha;
  delete process.env.RENDER_GIT_COMMIT;
  process.env.OPERATIONS_MONITOR_TOKEN = token;
  const tenant = await db.tenant.create({ data: { slug: "ops-" + suffix, name: "Operations fixture" } });
  const work = await db.work.create({ data: { tenantId: tenant.id, slug: "ops-work", title: "Operations fixture" } });
  const asset = await db.audioAsset.create({ data: { tenantId: tenant.id, workId: work.id, kind: "MASTER", status: "FAILED", fileName: "fixture.wav", storageKey: "private/never-publish-this-key" } });
  const user = await db.user.create({ data: { email: "ops-viewer-" + suffix + "@example.test" } });
  const admin = await db.user.create({ data: { email: "ops-admin-" + suffix + "@example.test", platformRole: "SUPER_ADMIN" } });
  const observer = startWorkerObservation("ASSET");
  try {
    const started = await observer.begin();
    assert.equal((await db.workerObservation.findUniqueOrThrow({ where: { id: observer.id } })).state, "BUSY");
    await observer.complete(started, true);
    const pulse = await db.workerObservation.findUniqueOrThrow({ where: { id: observer.id } });
    assert.equal(pulse.completed, 1);
    assert.equal(pulse.failed, 0);
    assert.equal(pulse.state, "IDLE");
    assert.equal(pulse.releaseSha, sha);
    await db.processingJob.create({ data: { tenantId: tenant.id, audioAssetId: asset.id, status: "QUEUED", runAfter: new Date(Date.now() - 600_000), lastError: "private diagnostic should never be returned" } });
    const deployment = await observeDeployment();
    assert.equal(deployment?.releaseSha, sha);
    const snapshot = await getOperationsSnapshot();
    assert.ok(snapshot.queues.ASSET.ready >= 1);
    assert.ok(snapshot.alerts.some((alert) => alert.key === "ASSET_QUEUE_DELAY"));
    const response = await monitor(new Request("https://ops.example/api/operations", { headers: { authorization: "Bearer " + token } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.equal(body.includes(asset.storageKey!), false);
    assert.equal(body.includes("private diagnostic"), false);
    assert.equal(body.includes(user.email!), false);
    await assert.rejects(recordOperationIncident(user.id, "ASSET_QUEUE_DELAY", "ACKNOWLEDGE"), /Unauthorized/);
    await assert.rejects(recordOperationIncident(admin.id, "invented-alert", "ACKNOWLEDGE"), /Unknown/);
    const acknowledged = await recordOperationIncident(admin.id, "ASSET_QUEUE_DELAY", "ACKNOWLEDGE");
    assert.equal(acknowledged.action, "OPERATION_ACKNOWLEDGE");
    await assert.rejects(recordOperationIncident(admin.id, "ASSET_QUEUE_DELAY", "RESOLVE"), /remains active/);
    await assert.rejects(db.platformAuditLog.update({ where: { id: acknowledged.id }, data: { action: "TAMPERED" } }));
    await db.processingJob.update({ where: { audioAssetId_type: { audioAssetId: asset.id, type: "PROCESS_AUDIO" } }, data: { status: "FAILED", attempts: 3, completedAt: new Date() } });
    assert.ok((await getOperationsSnapshot()).queues.ASSET.failed24h >= 1);
    await validateOperationsHttp(admin.id, user.id, token);
    console.log("Operations database/authenticated-monitor/incident integration passed.");
  } finally {
    await observer.stop();
    assert.equal((await db.workerObservation.findUniqueOrThrow({ where: { id: observer.id } })).state, "STOPPED");
    await db.workerObservation.delete({ where: { id: observer.id } });
    await db.tenant.delete({ where: { id: tenant.id } });
    await db.user.delete({ where: { id: user.id } });
    // Administrator is retained because the immutable audit ledger references it.
    for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

async function validateOperationsHttp(adminId: string, viewerId: string, monitorToken: string) {
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const origin = "http://127.0.0.1:" + port;
  const tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  await db.session.createMany({ data: tokens.map((sessionToken, index) => ({
    sessionToken, userId: index === 1 ? viewerId : adminId,
    expires: new Date(Date.now() + (index === 2 ? -60000 : 3600000)),
  })) });
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NODE_ENV: "development", NEXTAUTH_URL: origin, NEXTAUTH_SECRET: "synthetic-operations-http-secret", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Consume bounded synthetic fixture output; do not emit raw server diagnostics.
  app.stdout?.resume(); app.stderr?.resume();
  try {
    const started = Date.now();
    while (true) {
      if (app.exitCode !== null) throw new Error("Operations HTTP fixture exited.");
      try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (Date.now() - started > 30000) throw new Error("Operations HTTP fixture startup timeout.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    async function request(path: string, principal: number | null, options: { bearer?: string; method?: string; origin?: string; body?: string } = {}) {
      return fetch(origin + path, { method: options.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(30000),
        headers: { ...(principal === null ? {} : { cookie: "next-auth.session-token=" + tokens[principal] }),
          ...(options.bearer ? { authorization: "Bearer " + options.bearer } : {}),
          ...(options.origin ? { origin: options.origin } : {}), "content-type": "application/json" },
        body: options.body,
      });
    }
    assert.equal((await request("/api/operations", null)).status, 401);
    assert.equal((await request("/api/operations", null, { bearer: "invalid" })).status, 401);
    assert.equal((await request("/api/operations", 1)).status, 401);
    assert.equal((await request("/api/operations", 2)).status, 401);
    assert.equal((await request("/api/operations", 0)).status, 503);
    assert.equal((await request("/api/operations", null, { bearer: monitorToken })).status, 503);
    const body = JSON.stringify({ alertKey: "ASSET_QUEUE_DELAY", action: "ACKNOWLEDGE" });
    const endpoint = "/api/platform-admin/operations";
    assert.equal((await request(endpoint, null, { bearer: monitorToken, method: "POST", origin, body })).status, 401);
    assert.equal((await request(endpoint, 1, { method: "POST", origin, body })).status, 401);
    assert.equal((await request(endpoint, 0, { method: "POST", origin: "https://attacker.example", body })).status, 403);
    assert.equal((await request(endpoint, 0, { method: "POST", body })).status, 403);
    assert.equal((await request(endpoint, 0, { method: "POST", origin, body })).status, 200);
    await db.session.deleteMany({ where: { sessionToken: tokens[0] } });
    assert.equal((await request("/api/operations", 0)).status, 401);
  } finally {
    if (app.exitCode === null) {
      app.kill("SIGTERM");
      const timer = setTimeout(() => app.kill("SIGKILL"), 5000);
      await once(app, "exit"); clearTimeout(timer);
    }
    await db.session.deleteMany({ where: { sessionToken: { in: tokens } } });
  }
}
