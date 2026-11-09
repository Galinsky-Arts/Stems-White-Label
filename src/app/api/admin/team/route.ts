import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  getTeamState,
  issueTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
  revokeTeamMember,
  sendTeamInvitationEmail,
  updateTeamMemberRole,
  type TeamActor,
} from "@/lib/team-accounts";

function actorFromAccess(access: NonNullable<Awaited<ReturnType<typeof getTenantApiAccess>>>): TeamActor {
  return {
    id: access.session.user!.id,
    email: access.session.user?.email ?? null,
    role: access.membership.role,
  };
}

function publicOrigin(request: Request) {
  return new URL(request.url).origin;
}

export async function GET() {
  const access = await getTenantApiAccess("members.manage");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const team = await getTeamState(access.tenant.id);
  return NextResponse.json({
    ...team,
    currentUserId: access.session.user!.id,
    currentRole: access.membership.role,
  });
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("members.manage");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const actor = actorFromAccess(access);

  try {
    if (body.action === "invite") {
      const result = await issueTeamInvitation({
        actor,
        tenantId: access.tenant.id,
        email: body.email,
        role: body.role,
      });
      await sendTeamInvitationEmail({
        invitation: result.invitation,
        token: result.token,
        tenantName: access.tenant.name,
        origin: publicOrigin(request),
      });
    } else if (body.action === "resend_invitation") {
      if (typeof body.invitationId !== "string") {
        throw new Error("Invitation ID is required.");
      }
      const result = await resendTeamInvitation({
        actor,
        tenantId: access.tenant.id,
        invitationId: body.invitationId,
      });
      await sendTeamInvitationEmail({
        invitation: result.invitation,
        token: result.token,
        tenantName: access.tenant.name,
        origin: publicOrigin(request),
      });
    } else if (body.action === "revoke_invitation") {
      if (typeof body.invitationId !== "string") {
        throw new Error("Invitation ID is required.");
      }
      await revokeTeamInvitation({
        actor,
        tenantId: access.tenant.id,
        invitationId: body.invitationId,
      });
    } else if (body.action === "update_role") {
      if (typeof body.membershipId !== "string") {
        throw new Error("Membership ID is required.");
      }
      await updateTeamMemberRole({
        actor,
        tenantId: access.tenant.id,
        membershipId: body.membershipId,
        role: body.role,
      });
    } else if (body.action === "revoke_member") {
      if (typeof body.membershipId !== "string") {
        throw new Error("Membership ID is required.");
      }
      await revokeTeamMember({
        actor,
        tenantId: access.tenant.id,
        membershipId: body.membershipId,
      });
    } else {
      throw new Error("Unknown team action.");
    }

    const team = await getTeamState(access.tenant.id);
    return NextResponse.json({
      ...team,
      currentUserId: access.session.user!.id,
      currentRole: access.membership.role,
    });
  } catch (error) {
    const message =
      publicOperationError(error, "Unable to update the team.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
