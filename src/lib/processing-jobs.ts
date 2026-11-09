import { publicOperationError } from "./public-operation-error";

import { db } from "@/lib/db";

export function retryDelayMs(attempts: number) {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(15 * 60_000, 30_000 * 2 ** (safeAttempts - 1));
}

export function safeProcessingError(error: unknown) {
  if (error instanceof Error && /^Media command failed with exit code (?:[0-9]{1,3}|null)\.$/.test(error.message)) return error.message;
  return publicOperationError(error, "Processing failed. Inspect the job state and retry safely.").slice(0, 4000);
}

export async function claimNextProcessingJob(workerId: string) {
  const sql = [
    "WITH next_job AS (",
    "  SELECT \"id\"",
    "  FROM \"ProcessingJob\"",
    "  WHERE \"status\" = 'QUEUED'::\"ProcessingJobStatus\"",
    "    AND \"runAfter\" <= NOW()",
    "    AND \"attempts\" < \"maxAttempts\"",
    "  ORDER BY \"runAfter\" ASC, \"createdAt\" ASC",
    "  FOR UPDATE SKIP LOCKED",
    "  LIMIT 1",
    ")",
    "UPDATE \"ProcessingJob\" AS job",
    "SET \"status\" = 'RUNNING'::\"ProcessingJobStatus\",",
    "    \"attempts\" = job.\"attempts\" + 1,",
    "    \"lockedAt\" = NOW(),",
    "    \"lockedBy\" = $1,",
    "    \"startedAt\" = COALESCE(job.\"startedAt\", NOW()),",
    "    \"updatedAt\" = NOW()",
    "FROM next_job",
    "WHERE job.\"id\" = next_job.\"id\"",
    "RETURNING job.\"id\"",
  ].join("\n");

  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(sql, workerId);
  const id = rows[0]?.id;
  if (!id) return null;

  return db.processingJob.findUnique({
    where: { id },
    include: {
      audioAsset: true,
    },
  });
}

export async function recoverStaleProcessingJobs(staleMinutes: number) {
  const cutoff = new Date(Date.now() - Math.max(1, staleMinutes) * 60_000);
  const stale = await db.processingJob.findMany({
    where: {
      status: "RUNNING",
      lockedAt: { lt: cutoff },
    },
    select: {
      id: true,
      audioAssetId: true,
      attempts: true,
      maxAttempts: true,
      audioAsset: {
        select: {
          workId: true,
        },
      },
    },
  });

  let requeued = 0;
  let failed = 0;

  for (const job of stale) {
    if (job.attempts >= job.maxAttempts) {
      await db.$transaction([
        db.processingJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastError: "Worker lock expired after final processing attempt.",
          },
        }),
        db.audioAsset.update({
          where: { id: job.audioAssetId },
          data: { status: "FAILED" },
        }),
        db.work.updateMany({
          where: {
            id: job.audioAsset.workId,
            status: "PROCESSING",
          },
          data: { status: "DRAFT" },
        }),
      ]);
      failed += 1;
    } else {
      await db.processingJob.update({
        where: { id: job.id },
        data: {
          status: "QUEUED",
          runAfter: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: "Recovered stale worker lock.",
        },
      });
      requeued += 1;
    }
  }

  return { requeued, failed };
}

export async function markProcessingJobSucceeded(jobId: string) {
  await db.processingJob.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

export async function markProcessingJobFailed(input: {
  jobId: string;
  audioAssetId: string;
  workId: string;
  attempts: number;
  maxAttempts: number;
  error: unknown;
}) {
  const message = safeProcessingError(input.error);
  const exhausted = input.attempts >= input.maxAttempts;

  if (exhausted) {
    await db.$transaction([
      db.processingJob.update({
        where: { id: input.jobId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      }),
      db.audioAsset.update({
        where: { id: input.audioAssetId },
        data: { status: "FAILED" },
      }),
      db.work.updateMany({
        where: {
          id: input.workId,
          status: "PROCESSING",
        },
        data: { status: "DRAFT" },
      }),
    ]);

    return { exhausted: true, retryAt: null };
  }

  const retryAt = new Date(Date.now() + retryDelayMs(input.attempts));

  await db.processingJob.update({
    where: { id: input.jobId },
    data: {
      status: "QUEUED",
      runAfter: retryAt,
      lockedAt: null,
      lockedBy: null,
      lastError: message,
    },
  });

  return { exhausted: false, retryAt };
}
