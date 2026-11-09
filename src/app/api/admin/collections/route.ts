import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { normalizeCollectionDraft } from "@/lib/catalog-navigation";
import { db } from "@/lib/db";

async function validateWorkIds(tenantId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const works = await db.work.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, status: true },
  });
  if (works.length !== ids.length) {
    throw new Error("Collection contains a Work outside this tenant.");
  }
  return works;
}

export async function GET() {
  const access = await getTenantApiAccess("catalog.read");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const [collections, works] = await Promise.all([
    db.collection.findMany({
      where: { tenantId: access.tenant.id },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      include: {
        works: {
          orderBy: { position: "asc" },
          include: {
            work: {
              select: { id: true, title: true, slug: true, status: true },
            },
          },
        },
      },
    }),
    db.work.findMany({
      where: { tenantId: access.tenant.id, status: { not: "ARCHIVED" } },
      orderBy: [{ title: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, slug: true, status: true },
    }),
  ]);

  return NextResponse.json({ collections, works });
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await request.json().catch(() => null);

  try {
    const draft = normalizeCollectionDraft(body ?? {});
    const works = await validateWorkIds(access.tenant.id, draft.orderedWorkIds);

    if (
      draft.status === "PUBLISHED" &&
      !works.some((work) => work.status === "PUBLISHED")
    ) {
      throw new Error("A published Collection needs at least one published Work.");
    }

    const collection = await db.collection.create({
      data: {
        tenantId: access.tenant.id,
        title: draft.title,
        slug: draft.slug,
        description: draft.description,
        status: draft.status,
        publishedAt: draft.status === "PUBLISHED" ? new Date() : null,
        works: {
          create: draft.orderedWorkIds.map((workId, position) => ({
            workId,
            position,
          })),
        },
      },
      include: {
        works: {
          orderBy: { position: "asc" },
          include: {
            work: {
              select: { id: true, title: true, slug: true, status: true },
            },
          },
        },
      },
    });

    return NextResponse.json({ collection }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to create Collection.") },
      { status: 400 },
    );
  }
}
