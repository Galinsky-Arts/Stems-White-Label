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

    try {
      await processAudioAsset(job.audioAssetId);
      await markProcessingJobSucceeded(job.id);
      console.log("Processed audio asset");
    } catch (error) {
      const result = await markProcessingJobFailed({
        jobId: job.id,
        audioAssetId: job.audioAssetId,
        workId: job.audioAsset.workId,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error,
      });

      console.error("Audio asset processing failed", { attempt: job.attempts, exhausted: result.exhausted, retryAt: result.retryAt });
    }
  }
}

main()
  .catch((error) => {
    console.error("Asset worker terminated");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
