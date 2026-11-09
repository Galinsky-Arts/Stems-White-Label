import { lstat, readFile } from "node:fs/promises";

// This public repository cannot call a private cross-account reusable workflow.
// Keep the current inventory-only contract locally enforceable. Enabling active
// monitoring or failover requires expanding this validator and reviewing scope.
const path = new URL("../.github/deployment-monitor.json", import.meta.url);
const metadata = await lstat(path);
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536)
  throw new Error("Deployment inventory must be a bounded regular JSON file.");
const inventory = JSON.parse(await readFile(path, "utf8"));
const repository = process.env.GITHUB_REPOSITORY ?? "Galinsky-Arts/Stems-White-Label";
const valid = inventory.schema_version === 1 && inventory.repository === repository &&
  inventory.kind === "unclassified" && inventory.monitoring?.mode === "inventory" &&
  inventory.budget?.monthly_usd_max === 0 && inventory.budget?.allow_billable_fallback === false &&
  inventory.failover?.mode === "disabled" && inventory.failover?.stateful === false &&
  inventory.failover?.writer_fencing === false && inventory.failover?.router === "none" &&
  Array.isArray(inventory.deployments) && inventory.deployments.length === 0;
if (!valid) throw new Error("Stems monitoring must retain its reviewed zero-budget inventory-only contract.");
console.log("Deployment inventory verified; no active monitoring, paid fallback or failover is enabled.");
