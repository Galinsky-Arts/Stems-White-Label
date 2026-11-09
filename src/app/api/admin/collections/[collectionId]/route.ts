import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { normalizeCollectionDraft } from "@/lib/catalog-navigation";
import { db } from "@/lib/db";

type RouteProps = { params: Promise<{ collectionId: string }> };

export async function PATCH(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { collectionId } = await params;
  const existing = await db.collection.findFirst({
    where: { id: collectionId, tenantId: access.tenant.id },
    select: { id: true, status: true, publishedAt: true },
  });
  if (!existing) return NextResponse.json({ error: "Collection not found." }, { status: 404 });

  const body = await request.json().catch(() => null);

  try {
    const draft = normalizeCollectionDraft(body ?? {});
    const works =
      draft.orderedWorkIds.length === 0
        ? []
        : await db.work.findMany({
            where: {
              tenantId: access.tenant.id,
              id: { in: draft.orderedWorkIds },
            },
            select: { id: true, status: true },
          });

    if (works.length !== draft.orderedWorkIds.length) {
      throw new Error("Collection contains a Work outside this tenant.");
    }

    if (
      draft.status === "PUBLISHED" &&
      !works.some((work) => work.status === "PUBLISHED")
    ) {
      throw new Error("A published Collection needs at least one published Work.");
    }

    const publishedAt =
      draft.status === "PUBLISHED"
        ? existing.publishedAt ?? new Date()
        : null;

    const collection = await db.$transaction(async (tx) => {
      await tx.collectionWork.deleteMany({ where: { collectionId } });

      return tx.collection.update({
        where: { id: collectionId },
        data: {
          title: draft.title,
          slug: draft.slug,
          description: draft.description,
          status: draft.status,
          publishedAt,
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
    });

    return NextResponse.json({ collection });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to save Collection.") },
      { status: 400 },
    );
  }
}
