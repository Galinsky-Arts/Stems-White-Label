/** Keep an active job's lease alive without overlapping heartbeat queries. */
export function maintainWorkerLease(renew: () => PromiseLike<unknown>) {
  let pending: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = Promise.resolve().then(renew).catch(() => {
      console.error("Worker job lease heartbeat unavailable");
    }).finally(() => { pending = null; });
  }, 15000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
