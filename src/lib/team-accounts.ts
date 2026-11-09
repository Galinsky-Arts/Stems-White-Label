import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import nodemailer from "nodemailer";

import { subscriptionAccessState } from "@/lib/billing";
import { db } from "@/lib/db";

export type TeamActor = {
  id: string;
  email: string | null;
  role: "OWNER" | "ADMIN" | "CATALOG_MANAGER" | "FINANCE" | "VIEWER";
};

export type TeamRole = TeamActor["role"];

const TEAM_ROLES: readonly TeamRole[] = [
  "OWNER",
  "ADMIN",
  "CATALOG_MANAGER",
  "FINANCE",
  "VIEWER",
];

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeTeamEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("A valid email address is required.");
  }
  return email;
}

export function normalizeTeamRole(value: unknown): TeamRole {
  if (typeof value !== "string" || !TEAM_ROLES.includes(value as TeamRole)) {
    throw new Error("A valid tenant role is required.");
  }
  return value as TeamRole;
}

export function assertRoleAssignmentAllowed(
  actorRole: TeamRole,
  targetCurrentRole: TeamRole | null,
  requestedRole: TeamRole,
) {
  if (actorRole !== "OWNER") {
    if (targetCurrentRole === "OWNER" || requestedRole === "OWNER") {
      throw new Error("Only a tenant owner can manage the OWNER role.");
    }
  }
}

export function invitationIsActive(input: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}, now = new Date()) {
  return !input.acceptedAt && !input.revokedAt && input.expiresAt > now;
}

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createInvitationToken() {
  return randomBytes(32).toString("base64url");
}

function invitationExpiry(now = new Date()) {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

function auditJson(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Prisma.InputJsonValue;
}

async function appendTeamAudit(
  tx: Prisma.TransactionClient,
  input: {
    actor: { id: string; email: string | null };
    tenantId: string;
    action: string;
    targetType: string;
    targetId: string;
    reason?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  return tx.tenantAuditLog.create({
    data: {
      actorUserId: input.actor.id,
      actorEmail: input.actor.email,
      tenantId: input.tenantId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason ?? null,
      before: auditJson(input.before),
      after: auditJson(input.after),
    },
  });
}

async function assertSeatAvailable(
  tx: Prisma.TransactionClient,
  tenantId: string,
  options: { reservePendingInvitation?: boolean } = {},
) {
  const subscription = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: {
      status: true,
      pastDueGraceUntil: true,
      maxMembers: true,
    },
  });
  const access = subscriptionAccessState(subscription);
  if (!access.allowed) {
    throw new Error(access.reason ?? "SaaS subscription is not active.");
  }

  if (subscription?.maxMembers == null) return;

  const [members, pending] = await Promise.all([
    tx.tenantMembership.count({ where: { tenantId } }),
    options.reservePendingInvitation
      ? tx.tenantInvitation.count({
          where: {
            tenantId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        })
      : Promise.resolve(0),
  ]);

  if (members + pending + 1 > subscription.maxMembers) {
    throw new Error("Team member limit reached for the current SaaS plan.");
  }
}

async function assertNotRemovingLastOwner(
  tx: Prisma.TransactionClient,
  tenantId: string,
  currentRole: TeamRole,
) {
  if (currentRole !== "OWNER") return;
  const owners = await tx.tenantMembership.count({
    where: { tenantId, role: "OWNER" },
  });
  if (owners <= 1) {
    throw new Error("A tenant must always retain at least one OWNER.");
  }
}

export async function issueTeamInvitation(input: {
  actor: TeamActor;
  tenantId: string;
  email: unknown;
  role: unknown;
}) {
  const normalizedEmail = normalizeTeamEmail(input.email);
  const role = normalizeTeamRole(input.role);
  assertRoleAssignmentAllowed(input.actor.role, null, role);

  const token = createInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = invitationExpiry();

  const invitation = await db.$transaction(
    async (tx) => {
      const existingUser = await tx.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: "insensitive" } },
        select: { id: true },
      });
      if (existingUser) {
        const membership = await tx.tenantMembership.findUnique({
          where: {
            tenantId_userId: {
              tenantId: input.tenantId,
              userId: existingUser.id,
            },
          },
          select: { id: true },
        });
        if (membership) {
          throw new Error("That email address is already a team member.");
        }
      }

      const activeInvitation = await tx.tenantInvitation.findFirst({
        where: {
          tenantId: input.tenantId,
          normalizedEmail,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (activeInvitation) {
        const before = {
          id: activeInvitation.id,
          normalizedEmail: activeInvitation.normalizedEmail,
          role: activeInvitation.role,
          expiresAt: activeInvitation.expiresAt,
        };
        const updated = await tx.tenantInvitation.update({
          where: { id: activeInvitation.id },
          data: {
            email: normalizedEmail,
            role,
            tokenHash,
            expiresAt,
            invitedByUserId: input.actor.id,
          },
        });
        await appendTeamAudit(tx, {
          actor: input.actor,
          tenantId: input.tenantId,
          action: "TEAM_INVITATION_REISSUED",
          targetType: "TenantInvitation",
          targetId: updated.id,
          before,
          after: {
            id: updated.id,
            normalizedEmail: updated.normalizedEmail,
            role: updated.role,
            expiresAt: updated.expiresAt,
          },
        });
        return updated;
      }

      await assertSeatAvailable(tx, input.tenantId, {
        reservePendingInvitation: true,
      });

      const created = await tx.tenantInvitation.create({
        data: {
          tenantId: input.tenantId,
          email: normalizedEmail,
          normalizedEmail,
          role,
          tokenHash,
          expiresAt,
          invitedByUserId: input.actor.id,
        },
      });
      await appendTeamAudit(tx, {
        actor: input.actor,
        tenantId: input.tenantId,
        action: "TEAM_INVITATION_CREATED",
        targetType: "TenantInvitation",
        targetId: created.id,
        after: {
          id: created.id,
          normalizedEmail: created.normalizedEmail,
          role: created.role,
          expiresAt: created.expiresAt,
        },
      });
      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return { invitation, token };
}

export async function resendTeamInvitation(input: {
  actor: TeamActor;
  tenantId: string;
  invitationId: string;
}) {
  const token = createInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = invitationExpiry();

  const invitation = await db.$transaction(async (tx) => {
    const before = await tx.tenantInvitation.findFirst({
      where: { id: input.invitationId, tenantId: input.tenantId },
    });
    if (!before) throw new Error("Invitation not found.");
    if (before.acceptedAt) throw new Error("Accepted invitations cannot be resent.");
    if (before.revokedAt) throw new Error("Revoked invitations cannot be resent.");

    assertRoleAssignmentAllowed(input.actor.role, null, before.role as TeamRole);

    const after = await tx.tenantInvitation.update({
      where: { id: before.id },
      data: {
        tokenHash,
        expiresAt,
        invitedByUserId: input.actor.id,
      },
    });

    await appendTeamAudit(tx, {
      actor: input.actor,
      tenantId: input.tenantId,
      action: "TEAM_INVITATION_REISSUED",
      targetType: "TenantInvitation",
      targetId: after.id,
      before: {
        id: before.id,
        normalizedEmail: before.normalizedEmail,
        role: before.role,
        expiresAt: before.expiresAt,
      },
      after: {
        id: after.id,
        normalizedEmail: after.normalizedEmail,
        role: after.role,
        expiresAt: after.expiresAt,
      },
    });
    return after;
  });

  return { invitation, token };
}

export async function revokeTeamInvitation(input: {
  actor: TeamActor;
  tenantId: string;
  invitationId: string;
}) {
  return db.$transaction(async (tx) => {
    const before = await tx.tenantInvitation.findFirst({
      where: { id: input.invitationId, tenantId: input.tenantId },
    });
    if (!before) throw new Error("Invitation not found.");
    if (before.acceptedAt) throw new Error("Accepted invitations cannot be revoked.");
    if (before.revokedAt) return before;

    assertRoleAssignmentAllowed(input.actor.role, null, before.role as TeamRole);

    const after = await tx.tenantInvitation.update({
      where: { id: before.id },
      data: { revokedAt: new Date() },
    });
    await appendTeamAudit(tx, {
      actor: input.actor,
      tenantId: input.tenantId,
      action: "TEAM_INVITATION_REVOKED",
      targetType: "TenantInvitation",
      targetId: after.id,
      before: {
        normalizedEmail: before.normalizedEmail,
        role: before.role,
        revokedAt: before.revokedAt,
      },
      after: {
        normalizedEmail: after.normalizedEmail,
        role: after.role,
        revokedAt: after.revokedAt,
      },
    });
    return after;
  });
}

export async function updateTeamMemberRole(input: {
  actor: TeamActor;
  tenantId: string;
  membershipId: string;
  role: unknown;
}) {
  const role = normalizeTeamRole(input.role);

  return db.$transaction(
    async (tx) => {
      const before = await tx.tenantMembership.findFirst({
        where: { id: input.membershipId, tenantId: input.tenantId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!before) throw new Error("Team member not found.");

      assertRoleAssignmentAllowed(
        input.actor.role,
        before.role as TeamRole,
        role,
      );
      if (before.role === role) return before;

      if (before.role === "OWNER" && role !== "OWNER") {
        await assertNotRemovingLastOwner(
          tx,
          input.tenantId,
          before.role as TeamRole,
        );
      }

      const after = await tx.tenantMembership.update({
        where: { id: before.id },
        data: { role },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      await appendTeamAudit(tx, {
        actor: input.actor,
        tenantId: input.tenantId,
        action: "TEAM_MEMBER_ROLE_UPDATED",
        targetType: "TenantMembership",
        targetId: after.id,
        before: {
          userId: before.userId,
          email: before.user.email,
          role: before.role,
        },
        after: {
          userId: after.userId,
          email: after.user.email,
          role: after.role,
        },
      });
      return after;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function revokeTeamMember(input: {
  actor: TeamActor;
  tenantId: string;
  membershipId: string;
}) {
  return db.$transaction(
    async (tx) => {
      const before = await tx.tenantMembership.findFirst({
        where: { id: input.membershipId, tenantId: input.tenantId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!before) throw new Error("Team member not found.");

      assertRoleAssignmentAllowed(
        input.actor.role,
        before.role as TeamRole,
        before.role as TeamRole,
      );
      await assertNotRemovingLastOwner(
        tx,
        input.tenantId,
        before.role as TeamRole,
      );

      await tx.tenantMembership.delete({ where: { id: before.id } });
      await appendTeamAudit(tx, {
        actor: input.actor,
        tenantId: input.tenantId,
        action: "TEAM_MEMBER_REVOKED",
        targetType: "TenantMembership",
        targetId: before.id,
        before: {
          userId: before.userId,
          email: before.user.email,
          role: before.role,
        },
        after: null,
      });
      return before;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function acceptTeamInvitation(input: {
  tenantId: string;
  userId: string;
  userEmail: string | null | undefined;
  token: unknown;
}) {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length < 20 || token.length > 200) {
    throw new Error("Invitation token is invalid.");
  }
  const normalizedEmail = normalizeTeamEmail(input.userEmail);
  const tokenHash = hashInvitationToken(token);

  return db.$transaction(
    async (tx) => {
      const invitation = await tx.tenantInvitation.findFirst({
        where: {
          tenantId: input.tenantId,
          tokenHash,
        },
      });
      if (!invitation) throw new Error("Invitation not found.");
      if (!invitationIsActive(invitation)) {
        throw new Error("Invitation is expired, revoked, or already accepted.");
      }
      if (invitation.normalizedEmail !== normalizedEmail) {
        throw new Error("Sign in with the email address that was invited.");
      }

      const identity = await tx.user.findUnique({ where: { id: input.userId }, select: { email: true, emailVerified: true } });
      if (!identity?.emailVerified || !identity.email || normalizeTeamEmail(identity.email) !== normalizedEmail) {
        throw new Error("Verify the invited email address before accepting.");
      }

      const existing = await tx.tenantMembership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: input.tenantId,
            userId: input.userId,
          },
        },
      });

      if (!existing) {
        await assertSeatAvailable(tx, input.tenantId);
      }

      const membership =
        existing ??
        (await tx.tenantMembership.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            role: invitation.role,
          },
        }));

      const accepted = await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: {
          acceptedAt: new Date(),
          acceptedByUserId: input.userId,
        },
      });

      await appendTeamAudit(tx, {
        actor: { id: input.userId, email: normalizedEmail },
        tenantId: input.tenantId,
        action: "TEAM_INVITATION_ACCEPTED",
        targetType: "TenantInvitation",
        targetId: accepted.id,
        before: {
          normalizedEmail: invitation.normalizedEmail,
          role: invitation.role,
          acceptedAt: invitation.acceptedAt,
        },
        after: {
          normalizedEmail: accepted.normalizedEmail,
          role: accepted.role,
          acceptedAt: accepted.acceptedAt,
          membershipId: membership.id,
        },
      });

      return membership;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function getTeamState(tenantId: string) {
  const [members, invitations, audit] = await Promise.all([
    db.tenantMembership.findMany({
      where: { tenantId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
    db.tenantInvitation.findMany({
      where: {
        tenantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        normalizedEmail: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    db.tenantAuditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        actorEmail: true,
        action: true,
        targetType: true,
        targetId: true,
        reason: true,
        before: true,
        after: true,
        createdAt: true,
      },
    }),
  ]);
  return { members, invitations, audit };
}

export async function sendTeamInvitationEmail(input: {
  invitation: {
    email: string;
    role: TeamRole;
    expiresAt: Date;
  };
  token: string;
  tenantName: string;
  origin: string;
}) {
  const server = process.env.EMAIL_SERVER;
  const from = process.env.EMAIL_FROM;
  if (!server || !from) {
    throw new Error("Team invitation email is not configured.");
  }

  const callback = "/team/accept?token=" + encodeURIComponent(input.token);
  const signInUrl =
    input.origin +
    "/auth/sign-in?callbackUrl=" +
    encodeURIComponent(callback);

  const transport = nodemailer.createTransport(server);
  await transport.sendMail({
    to: input.invitation.email,
    from,
    subject: "Invitation to " + input.tenantName,
    text: [
      "You were invited to join " + input.tenantName + ".",
      "",
      "Role: " + input.invitation.role.replaceAll("_", " "),
      "Accept invitation: " + signInUrl,
      "",
      "This invitation expires " + input.invitation.expiresAt.toISOString() + ".",
      "If you were not expecting this invitation, you can ignore this email.",
    ].join("\n"),
  });
}
