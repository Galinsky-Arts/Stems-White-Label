import { startWorkerObservation } from "../src/lib/operations";
import { hostname } from "node:os";

import { processAudioAsset } from "../src/lib/audio-processor";
import { db } from "../src/lib/db";
import {
  claimNextProcessingJob,
  markProcessingJobFailed,
  markProcessingJobSucceeded,
  recoverStaleProcessingJobs,
} from "../src/lib/processing-jobs";

const workerId =
  "asset-worker:" + hostname() + ":" + process.pid + ":" + Date.now();
const pollMs = Math.max(250, Number(process.env.ASSET_WORKER_POLL_MS) || 2000);
const staleMinutes = Math.max(
  2,
  Number(process.env.ASSET_WORKER_STALE_MINUTES) || 20,
);

const observation = startWorkerObservation("ASSET");
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
  const recovered = await recoverStaleProcessingJobs(staleMinutes);

  if (recovered.requeued || recovered.failed) {
    console.log("Recovered stale asset jobs", recovered);
  }

  while (!stopping) {
    const job = await claimNextProcessingJob(workerId);

    if (!job) {
      await sleep(pollMs);
      continue;
    }

    const started = await observation.begin();
    try {
      await processAudioAsset(job.audioAssetId);
      await markProcessingJobSucceeded(job.id);
      await observation.complete(started, true);
      console.log("Asset job completed", { jobId: job.id, outcome: "succeeded" });
    } catch (error) {
      const result = await markProcessingJobFailed({
        jobId: job.id,
        audioAssetId: job.audioAssetId,
        workId: job.audioAsset.workId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error,
      });

      await observation.complete(started, false);
      console.error("Asset job failed", {
        jobId: job.id,
        outcome: result.exhausted ? "exhausted" : "retry_scheduled",
        nextAttemptAt: result.retryAt?.toISOString() ?? null,
      });
    }
  }
}

main()
  .catch((error) => {
    console.error("Asset worker terminated", { category: "worker-fatal", outcome: "failed" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await observation.stop();
    await db.$disconnect();
  });
