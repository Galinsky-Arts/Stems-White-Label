import { spawn } from "node:child_process";

export function mediaTimeoutMs(value = process.env.MEDIA_PROCESS_TIMEOUT_MS) {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 30 * 60_000) : 15 * 60_000;
}

export function runMediaCommand(executable: string, args: string[], options: {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  timeoutMs?: number;
} = {}) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const stop = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    const timer = setTimeout(() => stop("Media command exceeded its execution deadline."), options.timeoutMs ?? mediaTimeoutMs());
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxStdoutBytes ?? 64 * 1024 * 1024)) return stop("Media command exceeded the stdout safety limit.");
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > (options.maxStderrBytes ?? 256 * 1024)) return stop("Media command exceeded the stderr safety limit.");
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => stop("Media command could not be started."));
    child.once("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error("Media command failed with exit code " + String(code) + "."));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8").trim() });
    });
  });
}

// Accept supported standalone audio containers, never playlists/manifests that
// can reference private files or network resources during codec probing.
export const SAFE_MEDIA_INPUT_ARGS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,aiff,flac,mp3,mov,caf"];
