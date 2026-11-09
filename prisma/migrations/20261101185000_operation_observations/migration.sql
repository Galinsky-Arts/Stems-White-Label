CREATE TABLE "WorkerObservation" (
 "id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL,
 "lastSeenAt" TIMESTAMP(3) NOT NULL, "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "state" TEXT NOT NULL, "completed" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0,
 "lastDurationMs" INTEGER, "releaseSha" TEXT
);
CREATE INDEX "WorkerObservation_kind_lastSeenAt_idx" ON "WorkerObservation"("kind", "lastSeenAt");
CREATE TABLE "DeploymentObservation" (
 "id" TEXT NOT NULL PRIMARY KEY, "releaseSha" TEXT NOT NULL,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lastSeenAt" TIMESTAMP(3) NOT NULL, "source" TEXT NOT NULL
);
