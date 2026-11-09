import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { normalizeLicenseDraft } from "@/lib/licensing";

type RouteProps = { params: Promise<{ workId: string }> };

export async function GET(_request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.read");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { workId } = await params;
  const work = await db.work.findFirst({
    where: { id: workId, tenantId: access.tenant.id },
    select: {
      id: true,
      title: true,
      slug: true,
      stemGroups: {
        orderBy: { position: "asc" },
        select: { id: true, label: true },
      },
      licenseProducts: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: {
          selectedStems: { select: { stemGroupId: true } },
          versions: { orderBy: { version: "desc" } },
        },
      },
    },
  });

  if (!work) return NextResponse.json({ error: "Work not found." }, { status: 404 });
  return NextResponse.json({ work });
}

export async function POST(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { workId } = await params;
  const body = await request.json().catch(() => null);

  try {
    const draft = normalizeLicenseDraft(body ?? {});
    const work = await db.work.findFirst({
      where: { id: workId, tenantId: access.tenant.id },
      select: { id: true, stemGroups: { select: { id: true } } },
    });
    if (!work) return NextResponse.json({ error: "Work not found." }, { status: 404 });

    const stemIds = new Set(work.stemGroups.map((stem) => stem.id));
    if (draft.selectedStemGroupIds.some((id) => !stemIds.has(id))) {
      throw new Error("License contains a source group outside this Work.");
    }

    const position = await db.licenseProduct.count({ where: { workId } });
    const created = await db.licenseProduct.create({
      data: {
        tenantId: access.tenant.id,
        workId,
        slug: draft.slug,
        name: draft.name,
        summary: draft.summary,
        scope: draft.scope,
        position,
        selectedStems: {
          create: draft.selectedStemGroupIds.map((stemGroupId) => ({ stemGroupId })),
        },
        versions: {
          create: {
            version: 1,
            ...draft.version,
          },
        },
      },
      include: {
        selectedStems: true,
        versions: { orderBy: { version: "desc" } },
      },
    });

    return NextResponse.json({ licenseProduct: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to create license.") },
      { status: 400 },
    );
  }
}
