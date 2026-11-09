import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  ANALYTICS_SESSION_COOKIE,
  ANALYTICS_SESSION_MAX_AGE_SECONDS,
  PUBLIC_ANALYTICS_TYPES,
  createPublicAnalyticsEvent,
  normalizeAnalyticsEventId,
  normalizeAnalyticsPositionMs,
  normalizeAnalyticsSessionId,
} from "@/lib/analytics";
import { db } from "@/lib/db";
import { publicAnalyticsError } from "@/lib/public-api-errors";
import { getCurrentTenant } from "@/lib/tenant";

export async function POST(request: Request) {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return NextResponse.json({ error: "Storefront not found." }, { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 4096) {
    return NextResponse.json(
      { error: "Analytics payload is too large." },
      { status: 413 },
    );
  }

  const body = await request.json().catch(() => null);

  try {
    const type = String(body?.type ?? "") as Parameters<
      typeof PUBLIC_ANALYTICS_TYPES.has
    >[0];

    if (!PUBLIC_ANALYTICS_TYPES.has(type)) {
      throw new Error("Unsupported analytics event type.");
    }

    const clientEventId = normalizeAnalyticsEventId(body?.eventId);
    const positionMs = normalizeAnalyticsPositionMs(body?.positionMs);
    const workSlug =
      typeof body?.workSlug === "string" ? body.workSlug.trim() : "";

    if (!workSlug || workSlug.length > 180) {
      throw new Error("Work is required.");
    }

    const work = await db.work.findFirst({
      where: {
        tenantId: tenant.id,
        slug: workSlug,
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    if (!work) {
      return NextResponse.json({ error: "Work not found." }, { status: 404 });
    }

    const stemGroupId =
      typeof body?.stemGroupId === "string" && body.stemGroupId
        ? body.stemGroupId
        : null;

    if (stemGroupId) {
      const stem = await db.stemGroup.findFirst({
        where: {
          id: stemGroupId,
          workId: work.id,
        },
        select: { id: true },
      });
      if (!stem) {
        throw new Error("Source group does not belong to this Work.");
      }
    }

    const cookieStore = await cookies();
    const existingSession = cookieStore.get(ANALYTICS_SESSION_COOKIE)?.value;
    const sessionId = normalizeAnalyticsSessionId(existingSession);

    await createPublicAnalyticsEvent(db, {
      tenantId: tenant.id,
      type,
      workId: work.id,
      stemGroupId,
      sessionId,
      clientEventId,
      positionMs,
    });

    const response = new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });

    if (sessionId !== existingSession) {
      response.cookies.set(ANALYTICS_SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: ANALYTICS_SESSION_MAX_AGE_SECONDS,
      });
    }

    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          publicAnalyticsError(error),
      },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
