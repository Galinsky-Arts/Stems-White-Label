import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const requirePackage = createRequire(import.meta.url);
const runtime = globalThis as typeof globalThis & { stemsWorkerStop?: () => void };

/** One small-host supervisor. Queues and media remain in Postgres/private S3;
 * no job depends on the web instance's ephemeral filesystem surviving a restart.
 */
export function startIntegratedWorkers() {
  if (runtime.stemsWorkerStop) return runtime.stemsWorkerStop;
  let stopping = false;
  const children = new Set<ChildProcess>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const mediaPath = (configured: string | undefined, executable: string, fallback: () => string) => {
    if (configured) return configured;
    return spawnSync(executable, ["-version"], { stdio: "ignore", timeout: 5000 }).status === 0
      ? executable : fallback();
  };
  const env = {
    ...process.env,
    FFMPEG_PATH: mediaPath(process.env.FFMPEG_PATH, "ffmpeg", () => requirePackage("ffmpeg-static") as string),
    FFPROBE_PATH: mediaPath(process.env.FFPROBE_PATH, "ffprobe", () => (requirePackage("ffprobe-static") as { path: string }).path),
    // These subprocesses execute TS directly, outside the Next.js compiler.
    NEXT_RUNTIME: "",
    STEMS_INTEGRATED_WORKERS: "false",
  };
  for (const script of ["asset-worker.ts", "download-package-worker.ts"]) {
    let failures = 0;
    const launch = () => {
      if (stopping) return;
      const started = Date.now();
      const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts", script)], {
        env, stdio: ["ignore", "inherit", "inherit"],
      });
      children.add(child);
      // Never log arbitrary process exception details or environment values.
      child.once("error", () => console.error("Integrated worker could not start", { worker: script }));
      child.once("close", () => {
        children.delete(child);
        if (stopping) return;
        failures = Date.now() - started > 60000 ? 1 : Math.min(failures + 1, 6);
        const delay = Math.min(30000, 1000 * 2 ** (failures - 1));
        console.error("Integrated worker restarting", { worker: script, retryInMs: delay });
        const timer = setTimeout(() => { timers.delete(timer); launch(); }, delay);
        timer.unref(); timers.add(timer);
      });
    };
    launch();
  }
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    for (const child of children) child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 25000);
    deadline.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", stop);
  runtime.stemsWorkerStop = stop;
  console.log("Integrated audio and package workers started");
  return stop;
}
