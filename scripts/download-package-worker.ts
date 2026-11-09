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

    try {
      await buildDownloadPackage(packageId);
      console.log("Built licensed download package");
    } catch (error) {
      const result = await markDownloadPackageFailed({
        packageId,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        error,
      });
      console.error("Download package failed", { attempt: record.attempts, exhausted: result.exhausted, retryAt: result.retryAt });
    }
  }
}

main()
  .catch((error) => {
    console.error("Package worker terminated");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
