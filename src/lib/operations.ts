import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import registry from "../../registry/prs.json";
import { operationAlerts, releaseIdentity, type QueueMetric, type WorkerKind } from "./operations-policy";

export function startWorkerObservation(kind: WorkerKind) {
  const id = randomUUID();
  let state = "IDLE";
  let inFlight: Promise<unknown> | null = null;
  let failed = false;
  const pulse = () => {
    if (inFlight) return inFlight;
    inFlight = db.workerObservation.upsert({
      where: { id },
      create: { id, kind, state, lastSeenAt: new Date(), releaseSha: releaseIdentity() },
      update: { state, lastSeenAt: new Date(), releaseSha: releaseIdentity() },
    }).then(() => { failed = false; }).catch(() => {
      if (!failed) console.error("Worker observation write failed", { kind });
      failed = true;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  const timer = setInterval(() => { void pulse(); }, 15_000);
  timer.unref();
  void pulse();
  return {
    id,
    async begin() { state = "BUSY"; await inFlight; await pulse(); return Date.now(); },
    async complete(started: number, success: boolean) {
      state = "IDLE";
      await inFlight; await pulse();
      await db.workerObservation.update({
        where: { id },
        data: {
          lastDurationMs: Math.min(2147483647, Math.max(0, Date.now() - started)),
          ...(success ? { completed: { increment: 1 } } : { failed: { increment: 1 } }),
        },
      }).catch(() => { console.error("Worker result observation write failed", { kind }); });
    },
    async stop() { clearInterval(timer); state = "STOPPED"; await inFlight; await pulse(); },
  };
}

export async function observeDeployment() {
  const releaseSha = releaseIdentity();
  if (!releaseSha) return null;
  const source = process.env.RENDER_GIT_COMMIT ? "RENDER_GIT_COMMIT" : "GIT_SHA";
  const id = createHash("sha256").update(source + ":" + releaseSha).digest("hex");
  return db.deploymentObservation.upsert({
    where: { id },
    create: { id, releaseSha, source, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
}

async function queueMetric(kind: WorkerKind, now: Date): Promise<QueueMetric> {
  // Identifiers and enum values are selected only from fixed internal constants.
  const table = kind === "ASSET" ? "ProcessingJob" : "DownloadPackage";
  const running = kind === "ASSET" ? "RUNNING" : "PROCESSING";
  const completed = kind === "ASSET" ? "SUCCEEDED" : "READY";
  const staleMinutes = kind === "ASSET" ? 20 : 30;
  const rows = await db.$queryRawUnsafe<Array<{
    ready: bigint; processing: bigint; failed24h: bigint; completed24h: bigint;
    oldestReadyAt: Date | null; stale: bigint; averageDurationMs: number | null;
  }>>(`
    SELECT COUNT(*) FILTER (WHERE "status"::text = 'QUEUED' AND "runAfter" <= $1 AND "attempts" < "maxAttempts") AS "ready",
      COUNT(*) FILTER (WHERE "status"::text = '${running}') AS "processing",
      COUNT(*) FILTER (WHERE "status"::text = 'FAILED' AND "completedAt" >= $2) AS "failed24h",
      COUNT(*) FILTER (WHERE "status"::text = '${completed}' AND "completedAt" >= $2) AS "completed24h",
      MIN("runAfter") FILTER (WHERE "status"::text = 'QUEUED' AND "runAfter" <= $1 AND "attempts" < "maxAttempts") AS "oldestReadyAt",
      COUNT(*) FILTER (WHERE "status"::text = '${running}' AND ("lockedAt" IS NULL OR "lockedAt" < $3)) AS "stale",
      AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000)
        FILTER (WHERE "completedAt" >= $2 AND "completedAt" >= "startedAt")::float8 AS "averageDurationMs"
    FROM "${table}"`, now, new Date(now.getTime() - 86400_000), new Date(now.getTime() - staleMinutes * 60_000));
  const r = rows[0]!;
  return { ready: Number(r.ready), processing: Number(r.processing), failed24h: Number(r.failed24h), completed24h: Number(r.completed24h), oldestReadyAt: r.oldestReadyAt, stale: Number(r.stale), averageDurationMs: r.averageDurationMs };
}

export async function getOperationsSnapshot(now = new Date()) {
  const [asset, packages, workers, deployments, incidents] = await Promise.all([
    queueMetric("ASSET", now), queueMetric("PACKAGE", now),
    db.workerObservation.findMany({ where: { lastSeenAt: { gte: new Date(now.getTime() - 86400_000) } }, select: { id: true, kind: true, state: true, lastSeenAt: true, releaseSha: true, completed: true, failed: true, lastDurationMs: true }, orderBy: { lastSeenAt: "desc" }, take: 100 }),
    db.deploymentObservation.findMany({ orderBy: { observedAt: "desc" }, take: 10, select: { releaseSha: true, source: true, observedAt: true, lastSeenAt: true } }),
    db.platformAuditLog.findMany({ where: { targetType: "OPERATION_ALERT" }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, targetId: true, action: true, createdAt: true } }),
  ]);
  const queues = { ASSET: asset, PACKAGE: packages };
  const releaseSha = releaseIdentity();
  const expectedSha = process.env.OPERATIONS_EXPECTED_COMMIT ?? null;
  const registryObservedAt = registry.observedAt ?? null;
  const alerts = operationAlerts({ now, queues, workers, releaseSha, expectedSha, registryObservedAt });
  return { ok: alerts.length === 0, service: "stems-white-label", observedAt: now.toISOString(), releaseSha, expectedSha, source: { path: "registry/prs.json", observedAt: registryObservedAt }, queues, workers, deployments, incidents, alerts };
}

export async function recordOperationIncident(actorUserId: string, alertKey: unknown, action: unknown) {
  const actor = await db.user.findUnique({ where: { id: actorUserId }, select: { id: true, email: true, emailVerified: true, platformRole: true } });
  const bootstrap = new Set((process.env.PLATFORM_SUPER_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!actor || !(actor.platformRole === "SUPER_ADMIN" || (actor.emailVerified && actor.email && bootstrap.has(actor.email.toLowerCase())))) throw new Error("Unauthorized operation.");
  if (action !== "ACKNOWLEDGE" && action !== "RESOLVE") throw new Error("Invalid incident action.");
  const snapshot = await getOperationsSnapshot();
  const knownKeys = ["DEPLOYMENT_SOURCE_UNKNOWN", "DEPLOYMENT_SOURCE_STALE", "ROADMAP_SOURCE_STALE",
    ...["ASSET", "PACKAGE"].flatMap((k) => ["WORKER_MISSING", "LOCK_STALE", "QUEUE_DELAY", "FAILURES", "RELEASE_MISMATCH"].map((suffix) => k + "_" + suffix))];
  if (typeof alertKey !== "string" || !knownKeys.includes(alertKey)) throw new Error("Unknown operation alert.");
  if (action === "RESOLVE" && snapshot.alerts.some((alert) => alert.key === alertKey)) throw new Error("Alert condition remains active.");
  return db.platformAuditLog.create({
    data: { actorUserId: actor.id, actorEmail: actor.email, action: "OPERATION_" + action, targetType: "OPERATION_ALERT", targetId: alertKey },
    select: { id: true, targetId: true, action: true, createdAt: true },
  });
}
