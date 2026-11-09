import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, DeleteObjectsCommand, DeleteBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import Stripe from "stripe";
import { db } from "../src/lib/db";
import { createPendingOrder, quoteLicenseProducts } from "../src/lib/checkout";
import { requestDownloadPackage } from "../src/lib/download-packages";
import { getStorageClient, uploadFileToPrivateStorage } from "../src/lib/object-storage";

/** Full local flow using synthetic media, offline signed Stripe events and an S3 emulator.
 * This never charges a card or establishes production/provider acceptance.
 */
async function waitFor(check: () => Promise<boolean>, label: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for " + label);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await once(child, "exit");
  clearTimeout(timer);
}

async function main() {
  const databaseHost = new URL(process.env.DATABASE_URL!).hostname;
  const storageEndpoint = process.env.OBJECT_STORAGE_ENDPOINT!;
  assert.ok(["localhost", "127.0.0.1"].includes(databaseHost), "Browser fixtures require an isolated local database.");
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(storageEndpoint).hostname), "Browser fixtures require a local S3 emulator.");
  const suffix = randomBytes(6).toString("hex");
  const bucket = "stems-e2e-" + suffix;
  process.env.OBJECT_STORAGE_BUCKET = bucket;
  const storage = getStorageClient();
  const directory = await mkdtemp(join(tmpdir(), "stems-browser-"));
  const children: ChildProcess[] = [];
  const tenants: string[] = [];
  const users: string[] = [];
  const events: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const origin = "http://localhost:" + (process.env.STEMS_BROWSER_PORT || "3100");
  const sibling = origin.replace("localhost", "127.0.0.1");
  const secret = "whsec_synthetic_browser_" + suffix;
  try {
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
    for (const [index, hostname] of ["localhost", "127.0.0.1"].entries()) {
      assert.equal(await db.tenantDomain.count({ where: { hostname } }), 0, "Use a fresh test database; browser fixture host already exists.");
      const tenant = await db.tenant.create({ data: {
        name: "Browser Archive " + index, slug: "browser-" + index + "-" + suffix,
        domains: { create: { hostname, ownershipStatus: "VERIFIED", routingStatus: "READY", tlsStatus: "READY" } },
        subscription: { create: { status: "GRANDFATHERED", planKey: "fixture", planName: "Fixture" } },
      } });
      tenants.push(tenant.id);
    }
    const work = await db.work.create({ data: { tenantId: tenants[0]!, title: "Synthetic Session", slug: "synthetic-session", status: "PROCESSING", durationMs: 8000 } });
    const sourceFile = join(directory, "source.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-c:a", "pcm_s24le", sourceFile]);
    const sourceBytes = await readFile(sourceFile);
    for (const label of [null, "Rhythm", "Texture"]) {
      const group = label ? await db.stemGroup.create({ data: { workId: work.id, label, slug: label.toLowerCase() } }) : null;
      const key = "fixtures/" + suffix + "/" + (label || "master") + ".wav";
      await uploadFileToPrivateStorage({ storageKey: key, filePath: sourceFile, contentType: "audio/wav" });
      const asset = await db.audioAsset.create({ data: { tenantId: tenants[0]!, workId: work.id, stemGroupId: group?.id, kind: group ? "STEM" : "MASTER", status: "PROCESSING", fileName: (label || "master") + ".wav", storageKey: key, mimeType: "audio/wav", sizeBytes: BigInt(sourceBytes.length) } });
      await db.processingJob.create({ data: { tenantId: tenants[0]!, audioAssetId: asset.id } });
    }
    const start = (script: string[]) => {
      const child = spawn(process.execPath, script, {
        env: { ...process.env, STEMS_INTEGRATED_WORKERS: "true", NEXTAUTH_URL: origin, NEXTAUTH_SECRET: "synthetic-browser-session-" + suffix, STRIPE_SECRET_KEY: "sk_test_offline_browser", STRIPE_WEBHOOK_SECRET: secret, ASSET_WORKER_POLL_MS: "250", PACKAGE_WORKER_POLL_MS: "250", NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.resume(); child.stderr?.resume(); children.push(child); return child;
    };
    start(["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", new URL(origin).port]);
    await waitFor(async () => (await db.processingJob.count({ where: { tenantId: tenants[0], status: "SUCCEEDED" } })) === 3, "real asset worker processing");
    await db.work.update({ where: { id: work.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    const product = await db.licenseProduct.create({ data: { tenantId: tenants[0]!, workId: work.id, name: "Session License", slug: "session-license", scope: "ALL_STEMS", versions: { create: { version: 1, priceCents: 2500, termsText: "Synthetic fixture rights. No production music or payment." } } } });
    const user = await db.user.create({ data: { email: "buyer-" + suffix + "@example.test", emailVerified: new Date() } });
    users.push(user.id);
    const sessionToken = randomBytes(32).toString("hex");
    await db.session.create({ data: { userId: user.id, sessionToken, expires: new Date(Date.now() + 3600000) } });
    const quote = await quoteLicenseProducts(tenants[0]!, [product.id]);
    const order = await createPendingOrder(tenants[0]!, quote, true, user.email!);
    const checkoutId = "cs_fixture_" + suffix, intentId = "pi_fixture_" + suffix;
    await db.order.update({ where: { id: order.id }, data: { status: "CHECKOUT_CREATED", stripeCheckoutSessionId: checkoutId } });
    await waitFor(async () => { try { return (await fetch(origin + "/api/ready")).ok; } catch { return false; } }, "built HTTP application");
    const webhook = async (id: string, type: string, object: unknown) => {
      events.push(id);
      const payload = JSON.stringify({ id, type, data: { object } });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      const response = await fetch(origin + "/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload });
      assert.equal(response.status, 200, "Signed fixture webhook must be accepted.");
    };
    await webhook("evt_capture_" + suffix, "checkout.session.completed", { id: checkoutId, metadata: { orderId: order.id, tenantId: tenants[0] }, customer_details: { email: user.email }, payment_intent: intentId, amount_total: 2500, currency: "usd", mode: "payment", payment_status: "paid" });
    await webhook("evt_capture_" + suffix, "checkout.session.completed", { id: checkoutId });
    assert.equal(await db.purchaseLicense.count({ where: { orderId: order.id } }), 1);
    const purchase = await db.purchaseLicense.findFirstOrThrow({ where: { orderId: order.id }, include: { downloadEntitlements: true } });
    assert.equal(purchase.downloadEntitlements.length, 2);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addCookies([{ name: "next-auth.session-token", value: sessionToken, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + "/works/synthetic-session");
      await page.getByRole("heading", { name: "Synthetic Session", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal overflow at " + width);
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      assert.deepEqual(accessibility.violations.map(({ id, nodes }) => ({ id, count: nodes.length })), [], "Work page accessibility at " + width);
    }
    await page.getByRole("button", { name: "Load & play all stems", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.getByRole("button", { name: "Mute Rhythm", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Unmute Rhythm", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Unmute all", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("slider", { name: "Playback position" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Play all stems", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.goto(sibling + "/works/synthetic-session");
    assert.equal((await page.request.get(sibling + "/api/works/synthetic-session/audio-manifest")).status(), 404);
    const manifestResponse = await page.request.get(origin + "/api/works/synthetic-session/audio-manifest");
    const manifest = await manifestResponse.json();
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes("fixtures/") && !serialized.includes("master.wav"), "Public manifest must not contain private original keys.");
    const preview = await page.request.get(origin + manifest.stems[0].url, { headers: { Range: "bytes=0-99" } });
    assert.equal(preview.status(), 206); assert.equal((await preview.body()).length, 100);
    await page.goto(origin + "/library");
    await page.getByRole("heading", { name: "Synthetic Session", exact: true }).waitFor();
    const entitlementUrl = origin + "/api/library/downloads/" + purchase.downloadEntitlements[0]!.id;
    const download = await page.request.get(entitlementUrl);
    assert.equal(download.status(), 200);
    assert.equal(createHash("sha256").update(await download.body()).digest("hex"), createHash("sha256").update(sourceBytes).digest("hex"));
    const record = await requestDownloadPackage({ tenantId: tenants[0]!, customerId: purchase.customerId, purchaseLicenseId: purchase.id });
    await waitFor(async () => (await db.downloadPackage.findUniqueOrThrow({ where: { id: record.id } })).status === "READY", "real licensed package worker");
    const packaged = await page.request.get(origin + "/api/library/packages/" + record.id + "/download");
    assert.equal(packaged.status(), 200);
    const zipFile = join(directory, "license.zip"); await writeFile(zipFile, await packaged.body());
    assert.match(execFileSync("unzip", ["-l", zipFile], { encoding: "utf8" }), /LICENSE\.txt/);
    await webhook("evt_refund_" + suffix, "refund.created", { id: "re_fixture_" + suffix, payment_intent: intentId, status: "succeeded", amount: 2500 });
    assert.equal((await page.request.get(entitlementUrl)).status(), 404);
    assert.equal((await page.request.get(origin + "/api/library/packages/" + record.id + "/download")).status(), 404);
    assert.deepEqual(errors, [], "No browser runtime errors.");
    console.log("Browser acceptance passed: two tenants, desktop/mobile accessibility, real processed preview playback, mute/seek/resume, signed fixture fulfillment/replay, original checksum, real ZIP worker, and refund revocation.");
  } finally {
    await browser?.close();
    for (const child of children.reverse()) await stop(child);
    await db.stripeWebhookEvent.deleteMany({ where: { providerEventId: { in: events } } });
    await db.order.deleteMany({ where: { tenantId: { in: tenants } } });
    await db.tenant.deleteMany({ where: { id: { in: tenants } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    const objects = await storage.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
    if (objects?.Contents?.length) await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) } }));
    await storage.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    await db.$disconnect(); storage.destroy(); await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
