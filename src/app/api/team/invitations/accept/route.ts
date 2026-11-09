import { publicOperationError } from "@/lib/public-operation-error";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { acceptTeamInvitation } from "@/lib/team-accounts";
import { getCurrentTenant } from "@/lib/tenant";

export async function POST(request: Request) {
  const [tenant, session] = await Promise.all([
    getCurrentTenant(),
    getServerSession(authOptions),
  ]);

  if (!tenant || !session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const membership = await acceptTeamInvitation({
      tenantId: tenant.id,
      userId: session.user.id,
      userEmail: session.user.email,
      token: body.token,
    });
    return NextResponse.json({ membership });
  } catch (error) {
    const message =
      publicOperationError(error, "Unable to accept invitation.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
