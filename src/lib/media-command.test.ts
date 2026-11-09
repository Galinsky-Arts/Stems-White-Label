import assert from "node:assert/strict";
import test from "node:test";
import { mediaTimeoutMs, runMediaCommand } from "./media-command";

test("media commands bound stdout, stderr, execution time and diagnostic exposure", async () => {
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024))"], { maxStdoutBytes: 16 }), /stdout safety/);
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "process.stderr.write('x'.repeat(1024))"], { maxStderrBytes: 16 }), /stderr safety/);
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { timeoutMs: 20 }), /execution deadline/);
  await assert.rejects(runMediaCommand(process.execPath, ["-e", "console.error('private-key customer@example.com');process.exit(2)"]), (error: Error) => {
    assert.equal(error.message, "Media command failed with exit code 2.");
    assert.doesNotMatch(error.message, /private-key|customer@/); return true;
  });
  const result = await runMediaCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(result.stdout.toString(), "ok");
  assert.equal(mediaTimeoutMs("-1"), 15 * 60_000);
  assert.equal(mediaTimeoutMs("999999999"), 30 * 60_000);
});
