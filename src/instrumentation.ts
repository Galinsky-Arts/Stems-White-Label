export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" &&
      process.env.NEXT_PHASE !== "phase-production-build" &&
      process.env.STEMS_INTEGRATED_WORKERS === "true") {
    const { startIntegratedWorkers } = await import("./lib/integrated-workers");
    startIntegratedWorkers();
  }
}
