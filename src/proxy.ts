import { NextResponse, type NextRequest } from "next/server";
import { mutationOriginAllowed } from "./lib/mutation-origin";

export function proxy(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return NextResponse.next();
  const host = process.env.TRUST_X_FORWARDED_HOST === "true"
    ? request.headers.get("x-forwarded-host") ?? request.headers.get("host")
    : request.headers.get("host");
  if (!mutationOriginAllowed({
    origin: request.headers.get("origin"),
    fetchSite: request.headers.get("sec-fetch-site"),
    host,
    requestUrl: request.url,
    production: process.env.NODE_ENV === "production",
  })) {
    return NextResponse.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  return NextResponse.next();
}

// NextAuth enforces its own CSRF tokens. Provider webhooks use signatures.
export const config = {
  matcher: ["/api/admin/:path*", "/api/platform-admin/:path*", "/api/team/:path*", "/api/library/:path*"],
};
