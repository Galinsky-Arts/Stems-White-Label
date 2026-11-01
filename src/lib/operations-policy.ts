import { createHash, timingSafeEqual } from "node:crypto";

export const workerKinds = ["ASSET", "PACKAGE"] as const;
export type WorkerKind = typeof workerKinds[number];
export type QueueMetric = { ready: number; processing: number; failed24h: number; completed24h: number; oldestReadyAt: Date | null; stale: number; averageDurationMs: number | null };
export type Alert = { key: string; severity: "critical" | "warning"; message: string };

export function releaseIdentity(env: NodeJS.ProcessEnv = process.env) {
  const sha = env.RENDER_GIT_COMMIT ?? env.GIT_SHA;
  return sha && /^[a-f0-9]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}
export function monitorAuthorized(header: string | null, token: string | undefined) {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  // Hash both inputs before constant-time comparison, regardless of input length.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
export function operationAlerts(input: {
  now: Date;
  queues: Record<WorkerKind, QueueMetric>;
  workers: { kind: string; lastSeenAt: Date; state: string; releaseSha: string | null }[];
  releaseSha: string | null;
  expectedSha: string | null;
  registryObservedAt: string | null;
}) {
  const alerts: Alert[] = [];
  for (const kind of workerKinds) {
    const metric = input.queues[kind];
    const live = input.workers.filter((w) => w.kind === kind && w.state !== "STOPPED" &&
      w.lastSeenAt.getTime() <= input.now.getTime() &&
      input.now.getTime() - w.lastSeenAt.getTime() <= 90_000);
    if (!live.length) alerts.push({ key: kind + "_WORKER_MISSING", severity: "critical", message: kind + " worker has no heartbeat within 90 seconds." });
    if (metric.stale) alerts.push({ key: kind + "_LOCK_STALE", severity: "critical", message: kind + " queue has stalled processing locks." });
    if (metric.oldestReadyAt && input.now.getTime() - metric.oldestReadyAt.getTime() > 300_000)
      alerts.push({ key: kind + "_QUEUE_DELAY", severity: "warning", message: kind + " eligible work has waited over five minutes." });
    if (metric.failed24h) alerts.push({ key: kind + "_FAILURES", severity: "warning", message: kind + " queue has failed jobs in the last 24 hours." });
    if (input.releaseSha && live.some((w) => w.releaseSha !== input.releaseSha))
      alerts.push({ key: kind + "_RELEASE_MISMATCH", severity: "warning", message: kind + " worker release differs from the web release." });
  }
  if (!input.releaseSha) alerts.push({ key: "DEPLOYMENT_SOURCE_UNKNOWN", severity: "warning", message: "Web release commit is not configured." });
  if (input.expectedSha && input.releaseSha !== input.expectedSha)
    alerts.push({ key: "DEPLOYMENT_SOURCE_STALE", severity: "critical", message: "Running release differs from the expected Engine Room commit." });
  const observed = input.registryObservedAt ? Date.parse(input.registryObservedAt) : NaN;
  if (!Number.isFinite(observed) || observed > input.now.getTime() || input.now.getTime() - observed > 7 * 86400_000)
    alerts.push({ key: "ROADMAP_SOURCE_STALE", severity: "warning", message: "Roadmap source observation is missing, future-dated or older than seven days." });
  return alerts;
}
