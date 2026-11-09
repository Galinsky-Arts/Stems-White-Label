import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { signPreviewAccess } from "../src/lib/audio-preview-access";

/** Authenticated HTTP regression against an isolated app and synthetic database records. */
export async function validateSecurityHttp(suffix: string) {
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => { portProbe.once("error", reject); portProbe.listen(0, "127.0.0.1", resolve); });
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const tenants = await Promise.all(["a", "b"].map((letter) => db.tenant.create({ data: {
    name: "HTTP security " + letter,
    slug: "http-security-" + letter + "-" + suffix,
    domains: { create: { hostname: "security-" + letter + "-" + suffix + ".example", ownershipStatus: "VERIFIED", routingStatus: "READY", tlsStatus: "READY" } },
  } })));
  const users = await Promise.all(["owner", "viewer"].map((role) => db.user.create({ data: { email: role + "-http-" + suffix + "@example.com", emailVerified: new Date() } })));
  const tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  tokens.push(randomBytes(32).toString("hex")); // Expired owner session.
  let application: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    await db.tenantMembership.createMany({ data: [
      { tenantId: tenants[0]!.id, userId: users[0]!.id, role: "OWNER" },
      { tenantId: tenants[0]!.id, userId: users[1]!.id, role: "VIEWER" },
    ] });
    await db.session.createMany({ data: users.map((user, i) => ({ userId: user.id, sessionToken: tokens[i]!, expires: new Date(Date.now() + 60 * 60_000) })) });
    await db.session.create({ data: { userId: users[0]!.id, sessionToken: tokens[2]!, expires: new Date(Date.now() - 60_000) } });
    await db.customer.create({ data: { tenantId: tenants[0]!.id, userId: users[0]!.id, email: users[0]!.email!, normalizedEmail: users[0]!.email! } });
    const works = await Promise.all(tenants.map((tenant, i) => db.work.create({ data: { tenantId: tenant.id, slug: "http-work-" + i, title: "Private tenant " + i, status: "PUBLISHED", publishedAt: new Date() } })));
    const preview = await db.audioAsset.create({ data: { tenantId: tenants[1]!.id, workId: works[1]!.id, kind: "PREVIEW", status: "READY", fileName: "fixture.mp3", storageKey: "http-security/fixture.mp3" } });
    const original = await db.audioAsset.create({ data: { tenantId: tenants[0]!.id, workId: works[0]!.id, kind: "MASTER", status: "READY", fileName: "private-original.wav", storageKey: "http-security/private-original.wav" } });
    const historicalDiagnostic = "postgresql://worker:private-password@internal-db/private?customer=private@example.com";
    await db.processingJob.create({ data: {
      tenantId: tenants[0]!.id,
      audioAssetId: original.id,
      status: "FAILED",
      lastError: historicalDiagnostic,
    } });
    const secret = "offline-http-preview-secret-" + suffix;
    const origin = "http://127.0.0.1:" + port;
    const hosts = ["security-a-" + suffix + ".example", "security-b-" + suffix + ".example"];
    await db.$disconnect(); // The isolated app owns its own session pool.
    application = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: "development", NEXTAUTH_URL: origin, NEXTAUTH_SECRET: "offline-http-session-secret-" + suffix, PREVIEW_URL_SECRET: secret, NEXT_TELEMETRY_DISABLED: "1", TRUST_X_FORWARDED_HOST: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const remember = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    application.stdout?.on("data", remember); application.stderr?.on("data", remember);
    const started = Date.now();
    while (true) {
      if (application.exitCode !== null) throw new Error("Isolated security app exited during startup.");
      try { const health = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) }); if (health.ok) break; } catch { /* Wait only for the actual app startup. */ }
      if (Date.now() - started > 30000) throw new Error("Isolated security app startup exceeded 30 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    async function request(path: string, tenant = 0, principal: number | null = 0, method = "GET", requestOrigin?: string): Promise<Response> {
      // Native fetch replaces Host with the URL authority. Use the HTTP client
      // to exercise the real virtual-host boundary on the same loopback socket.
      return new Promise((resolve, reject) => {
        const outgoing = httpRequest(origin + path, { method, headers: {
          host: hosts[tenant]!, ...(principal !== null ? { cookie: "next-auth.session-token=" + tokens[principal] } : {}),
          ...(requestOrigin ? { origin: requestOrigin } : {}),
          ...(method !== "GET" ? { "content-type": "application/json" } : {}),
        } }, (incoming) => {
          const chunks: Buffer[] = []; let bytes = 0;
          incoming.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) { incoming.destroy(new Error("Security fixture response exceeded 1 MB.")); return; }
            chunks.push(chunk);
          });
          incoming.on("error", reject);
          incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500 })));
        });
        outgoing.on("error", reject);
        outgoing.setTimeout(30000, () => outgoing.destroy(new Error("Security fixture request timed out.")));
        outgoing.end(method !== "GET" ? "{}" : undefined);
      });
    }
    const sessionResponse = await request("/api/auth/session");
    const sessionData = await sessionResponse.json();
    assert.equal(sessionData.user?.id, users[0]!.id, "Synthetic database session was not accepted: " + JSON.stringify(sessionData));
    const own = await request("/api/admin/works");
    assert.equal(own.status, 200);
    const ownData = await own.json();
    assert.deepEqual(ownData.works.map((work: { id: string }) => work.id), [works[0]!.id]);
    const detail = await request("/api/admin/works/" + works[0]!.id);
    assert.equal(detail.status, 200);
    const detailBody = await detail.text();
    assert.equal(detailBody.includes(historicalDiagnostic), false);
    assert.equal(detailBody.includes("private-password"), false);
    const detailData = JSON.parse(detailBody);
    assert.equal(detailData.work.audioAssets[0].processingJobs[0].lastError,
      "Processing failed. Please retry or contact support.");
    assert.equal(detailData.work.audioAssets[0].processingJobs[0].status, "FAILED");
    assert.equal((await request("/api/admin/works", 1)).status, 401);
    assert.equal((await request("/api/admin/works", 0, null)).status, 401);
    assert.equal((await request("/api/admin/works", 0, 2)).status, 401);
    assert.equal((await request("/api/admin/works/" + works[1]!.id)).status, 404);
    assert.equal((await request("/api/admin/works", 0, 1, "POST", "http://" + hosts[0])).status, 401);
    assert.equal((await request("/api/admin/works", 0, 0, "POST", "http://" + hosts[1])).status, 403);
    assert.equal((await request("/api/admin/works", 0, 0, "POST")).status, 403);
    assert.equal((await request("/api/admin/works", 0, 0, "POST", "http://" + hosts[0])).status, 400);
    assert.equal((await request("/api/library/downloads/missing", 0)).status, 404);
    assert.equal((await request("/api/library/downloads/missing", 1)).status, 401);
    const signed = signPreviewAccess(preview.id, Math.floor(Date.now() / 1000) + 300, secret);
    const path = "/api/audio-preview/" + preview.id + "?exp=" + signed.expiresAtSeconds + "&sig=" + signed.signature;
    assert.equal((await request(path, 0, null)).status, 404);
    assert.equal((await request("/api/audio-preview/" + preview.id, 1, null)).status, 403);
    const masterSignature = signPreviewAccess(original.id, Math.floor(Date.now() / 1000) + 300, secret);
    assert.equal((await request("/api/audio-preview/" + original.id + "?exp=" + masterSignature.expiresAtSeconds + "&sig=" + masterSignature.signature, 0, null)).status, 404);
    assert.equal((await request("/api/admin/assets/" + preview.id)).status, 404);
    assert.equal((await request("/api/admin/assets/" + original.id)).status, 200);
    await db.session.deleteMany({ where: { sessionToken: tokens[0] } });
    assert.equal((await request("/api/admin/works")).status, 401);
    console.log("Authenticated HTTP security: tenant/role/session/origin/customer/preview negative cases passed.");
  } catch (error) {
    // This contains only logs from synthetic local fixtures, never provider keys.
    console.error("Isolated HTTP security fixture failed", output);
    throw error;
  } finally {
    if (application && application.exitCode === null) {
      application.kill("SIGTERM");
      const timer = setTimeout(() => application?.kill("SIGKILL"), 5000);
      await once(application, "exit"); clearTimeout(timer);
    }
    await db.tenant.deleteMany({ where: { id: { in: tenants.map((tenant) => tenant.id) } } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  }
}
