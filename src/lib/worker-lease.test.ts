import assert from "node:assert/strict";
import test from "node:test";
import { maintainWorkerLease } from "./worker-lease";

test("an in-flight lease renewal is serialized and shutdown drains it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  let complete!: () => void;
  const stop = maintainWorkerLease(() => {
    calls += 1;
    return new Promise<void>((resolve) => { complete = resolve; });
  });
  t.mock.timers.tick(15000); await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(60000); await Promise.resolve();
  assert.equal(calls, 1, "a slow database must not accumulate heartbeat queries");
  let stopped = false;
  const draining = stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  complete(); await draining;
  t.mock.timers.tick(60000); await Promise.resolve();
  assert.equal(calls, 1, "shutdown must not renew an already finished job");
});

test("lease failures do not emit provider credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const stop = maintainWorkerLease(() => Promise.reject(new Error("private-provider-credential")));
  t.mock.timers.tick(15000); await stop();
  assert.deepEqual(logged, [["Worker job lease heartbeat unavailable"]]);
});
