import assert from "node:assert/strict";

import { PrismaClient } from "@prisma/client";

import {
  acceptTeamInvitation,
  issueTeamInvitation,
  revokeTeamMember,
  updateTeamMemberRole,
} from "../src/lib/team-accounts";

const prisma = new PrismaClient();

async function main() {
  const stamp = Date.now().toString();
  const tenant = await prisma.tenant.create({
    data: {
      name: "Team Validation " + stamp,
      slug: "team-validation-" + stamp,
      subscription: {
        create: {
          status: "GRANDFATHERED",
          planKey: "test",
          planName: "Team test",
          maxMembers: 2,
          allowCustomDomains: false,
          allowWhiteLabel: false,
        },
      },
    },
  });

  const otherTenant = await prisma.tenant.create({
    data: {
      name: "Other Team " + stamp,
      slug: "other-team-" + stamp,
      subscription: {
        create: {
          status: "GRANDFATHERED",
          planKey: "test",
          planName: "Team test",
          maxMembers: 5,
          allowCustomDomains: false,
          allowWhiteLabel: false,
        },
      },
    },
  });

  const owner = await prisma.user.create({
    data: { email: "owner-" + stamp + "@example.com" },
  });
  const invitee = await prisma.user.create({
    data: { email: "invitee-" + stamp + "@example.com" },
  });
  const outsider = await prisma.user.create({
    data: { email: "outsider-" + stamp + "@example.com" },
  });

  const ownerMembership = await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: owner.id, role: "OWNER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: otherTenant.id, userId: outsider.id, role: "OWNER" },
  });

  const actor = {
    id: owner.id,
    email: owner.email,
    role: "OWNER" as const,
  };

  const issued = await issueTeamInvitation({
    actor,
    tenantId: tenant.id,
    email: invitee.email,
    role: "CATALOG_MANAGER",
  });

  const stored = await prisma.tenantInvitation.findUnique({
    where: { id: issued.invitation.id },
  });
  assert.ok(stored);
  assert.notEqual(stored.tokenHash, issued.token);
  assert.equal(stored.role, "CATALOG_MANAGER");

  await assert.rejects(
    issueTeamInvitation({
      actor,
      tenantId: tenant.id,
      email: "third-" + stamp + "@example.com",
      role: "VIEWER",
    }),
    /team member limit/i,
  );

  await assert.rejects(
    acceptTeamInvitation({
      tenantId: otherTenant.id,
      userId: invitee.id,
      userEmail: invitee.email,
      token: issued.token,
    }),
    /invitation not found/i,
  );

  await assert.rejects(acceptTeamInvitation({ tenantId: tenant.id, userId: invitee.id, userEmail: invitee.email, token: issued.token }), /verify the invited email/i);
  await prisma.user.update({ where: { id: invitee.id }, data: { emailVerified: new Date() } });
  await assert.rejects(acceptTeamInvitation({ tenantId: tenant.id, userId: outsider.id, userEmail: invitee.email, token: issued.token }), /verify the invited email/i);
  const membership = await acceptTeamInvitation({
    tenantId: tenant.id,
    userId: invitee.id,
    userEmail: invitee.email,
    token: issued.token,
  });
  assert.equal(membership.role, "CATALOG_MANAGER");

  const updated = await updateTeamMemberRole({
    actor,
    tenantId: tenant.id,
    membershipId: membership.id,
    role: "FINANCE",
  });
  assert.equal(updated.role, "FINANCE");

  await assert.rejects(
    revokeTeamMember({
      actor,
      tenantId: tenant.id,
      membershipId: ownerMembership.id,
    }),
    /at least one OWNER/i,
  );

  await revokeTeamMember({
    actor,
    tenantId: tenant.id,
    membershipId: membership.id,
  });
  assert.equal(
    await prisma.tenantMembership.count({
      where: { tenantId: tenant.id, userId: invitee.id },
    }),
    0,
  );

  const actions = await prisma.tenantAuditLog.findMany({
    where: { tenantId: tenant.id },
    select: { action: true },
  });
  const actionNames = new Set(actions.map((entry) => entry.action));
  for (const expected of [
    "TEAM_INVITATION_CREATED",
    "TEAM_INVITATION_ACCEPTED",
    "TEAM_MEMBER_ROLE_UPDATED",
    "TEAM_MEMBER_REVOKED",
  ]) {
    assert.equal(actionNames.has(expected), true, "missing audit action " + expected);
  }

  const audit = await prisma.tenantAuditLog.findFirst({
    where: { tenantId: tenant.id },
  });
  assert.ok(audit);

  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "TenantAuditLog" SET "action" = \'tampered\' WHERE "id" = $1',
      audit.id,
    ),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      'DELETE FROM "TenantAuditLog" WHERE "id" = $1',
      audit.id,
    ),
  );

  console.log("Team-account validation passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
