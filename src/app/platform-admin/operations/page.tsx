import { revalidatePath } from "next/cache";
import { requirePlatformSuperAdmin } from "@/lib/platform-access";
import { getOperationsSnapshot, observeDeployment, recordOperationIncident } from "@/lib/operations";
export const dynamic = "force-dynamic";
async function respond(formData: FormData) {
  "use server";
  const access = await requirePlatformSuperAdmin();
  await recordOperationIncident(access.user.id, formData.get("alertKey"), formData.get("action"));
  revalidatePath("/platform-admin/operations");
}
export default async function OperationsPage() {
  await requirePlatformSuperAdmin();
  await observeDeployment();
  const snapshot = await getOperationsSnapshot();
  return <main className="cms-shell">
    <header><p className="eyebrow">Platform operations</p><h1>Worker and deployment health</h1>
      <p>Observed {snapshot.observedAt}. Alerts remain active until their underlying condition is repaired.</p></header>
    <section className="cms-panel"><h2>Alerts</h2>
      {snapshot.alerts.length ? <ul>{snapshot.alerts.map((alert) => <li key={alert.key}>
        <strong>{alert.severity}: {alert.message}</strong>
        <form action={respond}><input type="hidden" name="alertKey" value={alert.key} />
          <button name="action" value="ACKNOWLEDGE">Acknowledge</button></form>
      </li>)}</ul> : <p>No current alerts.</p>}
    </section>
    <section className="cms-panel"><h2>Queues</h2><table><caption>Actual database queue state</caption><thead><tr>
      <th scope="col">Queue</th><th scope="col">Ready</th><th scope="col">Processing</th><th scope="col">Failed in 24h</th><th scope="col">Average duration</th>
    </tr></thead><tbody>{Object.entries(snapshot.queues).map(([kind, queue]) => <tr key={kind}>
      <th scope="row">{kind}</th><td>{queue.ready}</td><td>{queue.processing}</td><td>{queue.failed24h}</td><td>{queue.averageDurationMs === null ? "No completed observations" : Math.round(queue.averageDurationMs) + " ms"}</td>
    </tr>)}</tbody></table></section>
    <section className="cms-panel"><h2>Worker observations</h2>
      <table><caption>Recent worker heartbeats and execution outcomes</caption>
        <thead><tr><th scope="col">Worker</th><th scope="col">State</th><th scope="col">Last heartbeat</th><th scope="col">Completed</th><th scope="col">Failed attempts</th></tr></thead>
        <tbody>{snapshot.workers.map((worker) => <tr key={worker.id}>
          <th scope="row">{worker.kind}</th><td>{worker.state}</td><td><time dateTime={worker.lastSeenAt.toISOString()}>{worker.lastSeenAt.toISOString()}</time></td><td>{worker.completed}</td><td>{worker.failed}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <section className="cms-panel"><h2>Release and source</h2><p>Running commit: {snapshot.releaseSha ?? "Unknown"}</p>
      <p>Expected commit: {snapshot.expectedSha ?? "Not configured"}</p><p>Roadmap observed: {snapshot.source.observedAt ?? "Unknown"}</p>
      <ul>{snapshot.deployments.map((deployment) => <li key={deployment.releaseSha}>{deployment.releaseSha} observed {deployment.observedAt.toISOString()} from {deployment.source}</li>)}</ul>
    </section>
    <section className="cms-panel"><h2>Incident history</h2><ul>{snapshot.incidents.map((incident) => <li key={incident.id}>
      {incident.targetId}: {incident.action} at {incident.createdAt.toISOString()}
      {!snapshot.alerts.some((alert) => alert.key === incident.targetId) && incident.action === "OPERATION_ACKNOWLEDGE" ?
        <form action={respond}><input type="hidden" name="alertKey" value={incident.targetId} /><button name="action" value="RESOLVE">Resolve repaired alert</button></form> : null}
    </li>)}</ul></section>
  </main>;
}
