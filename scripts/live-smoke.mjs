/**
 * Public, credential-free availability check.
 * This verifies real JSON response bodies (not just an HTTP 200 from a proxy).
 * Scheduled GitHub Actions runs are best effort, not a substitute for production
 * telemetry or the dedicated asset/package worker processes.
 */
import { fileURLToPath } from "node:url";

export const DEFAULT_URL = "https://stems-white-label-preview.onrender.com";

export async function probeEndpoint(fetcher, base, path) {
  const url = new URL(path, base);
  const response = await fetcher(url, {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data || data.ok !== true || data.service !== "stems-white-label") {
    throw new Error(`${path}: unexpected health response`);
  }
  if (path === "/api/ready" && data.dependencies?.database !== "ready") {
    throw new Error("/api/ready: database has not reported ready");
  }
}

export async function probeDeployment(
  base,
  fetcher = fetch,
  { attempts = 6, delayMs = 15000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Monitoring target must use credential-free HTTPS");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probeEndpoint(fetcher, parsed, "/api/health");
      await probeEndpoint(fetcher, parsed, "/api/ready");
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Optional authenticated queue/worker monitor; never follows redirects with the bearer. */
export async function probeOperations(fetcher, base, token) {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Operational monitor target must use credential-free HTTPS");
  if (typeof token !== "string" || token.length < 32) throw new Error("Operational monitor token is not configured");
  const response = await fetcher(new URL("/api/operations", parsed), {
    headers: { authorization: "Bearer " + token },
    redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Operational monitor is not healthy (HTTP " + response.status + ")");
  }
  const data = await response.json();
  if (data?.ok !== true || data.service !== "stems-white-label" || !Array.isArray(data.alerts) || data.alerts.length)
    throw new Error("Operational monitor returned an unhealthy response");
  const age = Date.now() - Date.parse(data.observedAt);
  if (!Number.isFinite(age) || age < -30000 || age > 90000)
    throw new Error("Operational monitor returned a stale observation");
  return { ok: true };
}

export async function main() {
  const target = process.env.STEMS_SITE_URL ?? DEFAULT_URL;
  const result = await probeDeployment(target);
  if (process.env.STEMS_OPERATIONS_MONITOR_TOKEN) {
    await probeOperations(fetch, target, process.env.STEMS_OPERATIONS_MONITOR_TOKEN);
    console.log("Stems authenticated worker/queue operations: PASS");
  }
  console.log(`Stems public liveness + database readiness: PASS (${result.attempts} attempt(s))`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Stems storefront readiness\nLiveness and database readiness: **PASS** after ${result.attempts} attempt(s).\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL("file://" + process.argv[1]))) {
  main().catch((error) => {
    console.error("Stems public readiness: FAIL:", error instanceof Error ? error.message : "Unknown failure");
    process.exitCode = 1;
  });
}
