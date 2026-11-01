import { NextResponse } from "next/server";
import { getPlatformAccess } from "@/lib/platform-access";
import { monitorAuthorized } from "@/lib/operations-policy";
import { getOperationsSnapshot, observeDeployment } from "@/lib/operations";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const monitor = monitorAuthorized(request.headers.get("authorization"), process.env.OPERATIONS_MONITOR_TOKEN);
  try {
    if (!monitor && !(await getPlatformAccess())) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    await observeDeployment();
    const snapshot = await getOperationsSnapshot();
    return NextResponse.json(snapshot, { status: snapshot.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, service: "stems-white-label", error: "Operational monitoring unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
