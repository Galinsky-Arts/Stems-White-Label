import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { normalizeLicenseDraft } from "@/lib/licensing";

type RouteProps = { params: Promise<{ licenseProductId: string }> };

function versionChanged(
  current: {
    priceCents: number;
    currency: string;
    termsText: string;
    attributionRequired: boolean;
    commercialUseAllowed: boolean;
    derivativesAllowed: boolean;
    redistributionAllowed: boolean;
    seatLimit: number | null;
    projectLimit: number | null;
  },
  next: typeof current,
) {
  return Object.keys(current).some((key) =>
    current[key as keyof typeof current] !== next[key as keyof typeof next],
  );
}

export async function PATCH(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { licenseProductId } = await params;
  const body = await request.json().catch(() => null);

  const existing = await db.licenseProduct.findFirst({
    where: { id: licenseProductId, tenantId: access.tenant.id },
    include: {
      work: { select: { stemGroups: { select: { id: true } } } },
      selectedStems: true,
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!existing) return NextResponse.json({ error: "License not found." }, { status: 404 });

  try {
    const draft = normalizeLicenseDraft(body ?? {});
    const allowedStemIds = new Set(existing.work.stemGroups.map((stem) => stem.id));
    if (draft.selectedStemGroupIds.some((id) => !allowedStemIds.has(id))) {
      throw new Error("License contains a source group outside this Work.");
    }

    const current = existing.versions[0];
    if (!current) throw new Error("License has no current version.");

    const nextVersionData = draft.version;
    const needsVersion = versionChanged(
      {
        priceCents: current.priceCents,
        currency: current.currency,
        termsText: current.termsText,
        attributionRequired: current.attributionRequired,
        commercialUseAllowed: current.commercialUseAllowed,
        derivativesAllowed: current.derivativesAllowed,
        redistributionAllowed: current.redistributionAllowed,
        seatLimit: current.seatLimit,
        projectLimit: current.projectLimit,
      },
      nextVersionData,
    );

    const updated = await db.$transaction(async (tx) => {
      await tx.licenseProduct.update({
        where: { id: existing.id },
        data: {
          slug: draft.slug,
          name: draft.name,
          summary: draft.summary,
          scope: draft.scope,
          selectedStems: {
            deleteMany: {},
            create: draft.selectedStemGroupIds.map((stemGroupId) => ({ stemGroupId })),
          },
        },
      });

      if (needsVersion) {
        await tx.licenseVersion.update({
          where: { id: current.id },
          data: { retiredAt: new Date() },
        });
        await tx.licenseVersion.create({
          data: {
            licenseProductId: existing.id,
            version: current.version + 1,
            ...nextVersionData,
          },
        });
      }

      return tx.licenseProduct.findUniqueOrThrow({
        where: { id: existing.id },
        include: {
          selectedStems: true,
          versions: { orderBy: { version: "desc" } },
        },
      });
    });

    return NextResponse.json({ licenseProduct: updated });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to update license.") },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { licenseProductId } = await params;
  const body = (await request.json().catch(() => null)) as { action?: string } | null;

  const existing = await db.licenseProduct.findFirst({
    where: { id: licenseProductId, tenantId: access.tenant.id },
    select: { id: true, isActive: true },
  });
  if (!existing) return NextResponse.json({ error: "License not found." }, { status: 404 });

  if (body?.action !== "activate" && body?.action !== "deactivate") {
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  }

  const updated = await db.licenseProduct.update({
    where: { id: existing.id },
    data: { isActive: body.action === "activate" },
    select: { id: true, isActive: true },
  });
  return NextResponse.json({ licenseProduct: updated });
}
