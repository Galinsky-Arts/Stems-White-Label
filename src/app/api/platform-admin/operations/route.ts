import { mutationOriginAllowed } from "@/lib/mutation-origin";
import { readOperationBody } from "@/lib/operation-request";
import { NextResponse } from "next/server";
import { getPlatformAccess } from "@/lib/platform-access";
import { recordOperationIncident } from "@/lib/operations";
export async function POST(request: Request) {
  // Monitoring bearer credentials are read-only; incident actions require a session.
  const access = await getPlatformAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!mutationOriginAllowed({
    origin: request.headers.get("origin"),
    host: process.env.TRUST_X_FORWARDED_HOST === "true"
      ? request.headers.get("x-forwarded-host") ?? request.headers.get("host")
      : request.headers.get("host"),
    requestUrl: request.url,
    production: process.env.NODE_ENV === "production",
    fetchSite: request.headers.get("sec-fetch-site"),
  }))
    return NextResponse.json({ error: "Forbidden origin." }, { status: 403 });
  try {
    const body = await readOperationBody(request);
    const incident = await recordOperationIncident(access.user.id, body?.alertKey, body?.action);
    return NextResponse.json({ incident }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Incident action rejected. Verify the alert and its current condition." }, { status: 409 });
  }
}
