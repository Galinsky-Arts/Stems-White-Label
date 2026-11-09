import { readOperationBody } from "@/lib/operation-request";
import { NextResponse } from "next/server";
import { getPlatformAccess } from "@/lib/platform-access";
import { recordOperationIncident } from "@/lib/operations";
export async function POST(request: Request) {
  // Monitoring bearer credentials are read-only; incident actions require a session.
  const access = await getPlatformAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return NextResponse.json({ error: "Forbidden origin." }, { status: 403 });
  try {
    const body = await readOperationBody(request);
    const incident = await recordOperationIncident(access.user.id, body?.alertKey, body?.action);
    return NextResponse.json({ incident }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Incident action rejected. Verify the alert and its current condition." }, { status: 409 });
  }
}
