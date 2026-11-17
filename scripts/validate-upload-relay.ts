import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";

import { db } from "../src/lib/db";
import { getStorageClient } from "../src/lib/object-storage";
import { RELAY_CHUNK_BYTES } from "../src/lib/relay-upload";
import { uploadToPrivateStorage } from "../src/lib/upload-client";

/**
 * End-to-end catalog upload proof against an isolated app + local S3 emulator:
 * the real browser upload client sees the direct bucket PUT fail (as a missing
 * bucket CORS rule does) and relays the file through the app in chunks; the
 * stored object is byte-identical and the asset is queued for processing.
 */
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function main() {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.OBJECT_STORAGE_ENDPOINT ?? "http://invalid").hostname), "Requires a local S3 emulator.");
  const suffix = randomBytes(5).toString("hex");
  process.env.OBJECT_STORAGE_BUCKET = "stems-relay-" + suffix;
  await getStorageClient().send(new CreateBucketCommand({ Bucket: process.env.OBJECT_STORAGE_BUCKET }));
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const tenant = await db.tenant.create({ data: { name: "Relay", slug: "relay-" + suffix } });
  await db.tenantSubscription.create({ data: { tenantId: tenant.id, status: "GRANDFATHERED", planKey: "flagship", planName: "Flagship" } });
  const otherTenant = await db.tenant.create({ data: { name: "Relay other", slug: "relay-other-" + suffix } });
  const user = await db.user.create({ data: { email: "relay-" + suffix + "@example.com", emailVerified: new Date() } });
  await db.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "OWNER" } });
  const token = randomBytes(32).toString("hex");
  await db.session.create({ data: { userId: user.id, sessionToken: token, expires: new Date(Date.now() + 3600_000) } });
  const work = await db.work.create({ data: { tenantId: tenant.id, slug: "relay-work", title: "Relay work" } });
  const otherWork = await db.work.create({ data: { tenantId: otherTenant.id, slug: "relay-other", title: "Other" } });
  const foreignAsset = await db.audioAsset.create({ data: { tenantId: otherTenant.id, workId: otherWork.id, kind: "MASTER", status: "PENDING", fileName: "x.wav", mimeType: "audio/wav", sizeBytes: BigInt(10), storageKey: "relay/" + suffix + "/foreign.wav" } });
  await db.$disconnect();

  let app: ChildProcess | undefined;
  let output = "";
  try {
    app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "development", NEXTAUTH_URL: origin, NEXTAUTH_SECRET: "relay-secret-" + suffix, DEFAULT_TENANT_SLUG: tenant.slug, STEMS_INTEGRATED_WORKERS: "false", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const remember = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    app.stdout?.on("data", remember); app.stderr?.on("data", remember);
    const started = Date.now();
    for (;;) {
      if (app.exitCode !== null) throw new Error("App exited during startup.");
      try { if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      if (Date.now() - started > 60_000) throw new Error("App startup exceeded 60 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // Same-origin, signed-in app requests; any other URL is the "bucket".
    let directAttempts = 0;
    const browserFetch: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (!url.startsWith("/")) {
        directAttempts += 1;
        throw new TypeError("Failed to fetch"); // what a browser reports for a CORS-blocked PUT
      }
      const headers = new Headers(init.headers);
      headers.set("cookie", "next-auth.session-token=" + token);
      headers.set("origin", origin);
      return fetch(origin + url, { ...init, headers, ...(init.body ? { duplex: "half" } : {}) } as RequestInit);
    };

    const bytes = randomBytes(RELAY_CHUNK_BYTES * 2 + 777_777); // 3 parts, last one short
    const intent = await browserFetch("/api/admin/works/" + work.id + "/assets/upload-intent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: "relay-master.wav", mimeType: "audio/wav", sizeBytes: bytes.byteLength, kind: "MASTER" }),
    });
    assert.equal(intent.status, 201, await intent.clone().text());
    const intentBody = await intent.json() as { assetId: string; uploadUrl: string; requiredHeaders: Record<string, string> };

    // Negative cases on the relay endpoint.
    const tooBig = await browserFetch("/api/admin/uploads/relay?" + new URLSearchParams({ kind: "audio", assetId: intentBody.assetId, uploadId: "x", partNumber: "1" }), { method: "PUT", body: new Uint8Array(RELAY_CHUNK_BYTES + 1) });
    assert.equal(tooBig.status, 413);
    const foreign = await browserFetch("/api/admin/uploads/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", kind: "audio", assetId: foreignAsset.id }) });
    assert.equal(foreign.status, 404);
    const crossSite = await fetch(origin + "/api/admin/uploads/relay", { method: "POST", headers: { "content-type": "application/json", cookie: "next-auth.session-token=" + token, origin: "https://evil.example" }, body: "{}" });
    assert.equal(crossSite.status, 403);
    const anonymous = await fetch(origin + "/api/admin/uploads/relay", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ action: "start", kind: "audio", assetId: intentBody.assetId }) });
    assert.equal(anonymous.status, 401);

    let fellBack = false;
    const mode = await uploadToPrivateStorage({
      file: new Blob([bytes]), uploadUrl: intentBody.uploadUrl, requiredHeaders: intentBody.requiredHeaders,
      kind: "audio", assetId: intentBody.assetId, onFallback: () => { fellBack = true; }, fetchImpl: browserFetch,
    });
    assert.equal(mode, "relay");
    assert.equal(fellBack, true);
    assert.equal(directAttempts, 1);

    const complete = await browserFetch("/api/admin/assets/" + intentBody.assetId + "/complete", { method: "POST" });
    assert.ok([200, 202].includes(complete.status), await complete.clone().text());

    const verify = new PrismaVerifier();
    const asset = await verify.asset(intentBody.assetId);
    assert.ok(asset?.storageKey);
    const object = await getStorageClient().send(new GetObjectCommand({ Bucket: process.env.OBJECT_STORAGE_BUCKET, Key: asset.storageKey }));
    const stored = Buffer.from(await object.Body!.transformToByteArray());
    assert.equal(stored.byteLength, bytes.byteLength);
    assert.equal(createHash("sha256").update(stored).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.equal(await verify.jobCount(intentBody.assetId), 1);
    await verify.close();
    console.log("Upload relay validation passed: direct PUT blocked -> chunked relay, byte-identical object, processing queued, negative cases rejected.");
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    app?.kill("SIGTERM");
    await db.tenant.deleteMany({ where: { id: { in: [tenant.id, otherTenant.id] } } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}

class PrismaVerifier {
  asset(id: string) { return db.audioAsset.findUnique({ where: { id }, select: { storageKey: true } }); }
  jobCount(audioAssetId: string) { return db.processingJob.count({ where: { audioAssetId } }); }
  close() { return db.$disconnect(); }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
