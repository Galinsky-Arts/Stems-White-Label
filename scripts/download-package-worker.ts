import { startWorkerObservation } from "../src/lib/operations";
import { hostname } from "node:os";

import { db } from "../src/lib/db";
import {
  buildDownloadPackage,
  claimNextDownloadPackage,
  markDownloadPackageFailed,
  recoverStaleDownloadPackages,
} from "../src/lib/download-packages";

const workerId =
  "package-worker:" + hostname() + ":" + process.pid + ":" + Date.now();
const pollMs = Math.max(
  250,
  Number(process.env.PACKAGE_WORKER_POLL_MS) || 2000,
);
const staleMinutes = Math.max(
  2,
  Number(process.env.PACKAGE_WORKER_STALE_MINUTES) || 30,
);

const observation = startWorkerObservation("PACKAGE");
let stopping = false;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function main() {
  const recovered = await recoverStaleDownloadPackages(staleMinutes);
  if (recovered.requeued || recovered.failed) {
    console.log("Recovered stale package jobs", recovered);
  }

  while (!stopping) {
    const packageId = await claimNextDownloadPackage(workerId);
    if (!packageId) {
      await sleep(pollMs);
      continue;
    }

    const record = await db.downloadPackage.findUnique({
      where: { id: packageId },
      select: { attempts: true, maxAttempts: true },
    });
    if (!record) continue;

    const started = await observation.begin();
    try {
      await buildDownloadPackage(packageId);
      await observation.complete(started, true);
      console.log("Download package completed", { outcome: "succeeded" });
    } catch (error) {
      const result = await markDownloadPackageFailed({
        packageId,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        error,
      });
      await observation.complete(started, false);
      console.error("Download package failed", { outcome: result.exhausted ? "exhausted" : "retry_scheduled", nextAttemptAt: result.retryAt?.toISOString() ?? null });
    }
  }
}

main()
  .catch((error) => {
    console.error("Package worker terminated", { outcome: "failed" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await observation.stop();
    await db.$disconnect();
  });
