import { publicOperationError, publicStoredError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  normalizeCredits,
  normalizeReveal,
  normalizeSections,
  normalizeStemInputs,
  normalizeWorkInput,
  validatePublishReadiness,
  type CatalogEditorCredit,
  type CatalogEditorReveal,
  type CatalogEditorSection,
  type CatalogEditorStem,
} from "@/lib/catalog-cms";
import { db } from "@/lib/db";

type WorkRouteProps = {
  params: Promise<{ workId: string }>;
};

async function findTenantWork(tenantId: string, workId: string) {
  return db.work.findFirst({
    where: { id: workId, tenantId },
    include: {
      primaryArtist: true,
      artwork: true,
      credits: { orderBy: { position: "asc" } },
      sections: { orderBy: { position: "asc" } },
      stemGroups: {
        orderBy: { position: "asc" },
        include: {
          audioAssets: {
            where: { sourceAssetId: null },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              kind: true,
              status: true,
              label: true,
              fileName: true,
              durationMs: true,
              sampleRateHz: true,
              bitDepth: true,
              channels: true,
              processingJobs: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  status: true,
                  attempts: true,
                  maxAttempts: true,
                  lastError: true,
                },
              },
            },
          },
        },
      },
      audioAssets: {
        where: {
          sourceAssetId: null,
          stemGroupId: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          status: true,
          label: true,
          fileName: true,
          durationMs: true,
          sampleRateHz: true,
          bitDepth: true,
          channels: true,
          processingJobs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              status: true,
              attempts: true,
              maxAttempts: true,
              lastError: true,
            },
          },
        },
      },
      collections: {
        orderBy: { position: "asc" },
        include: { collection: true },
      },
      revealSequences: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        take: 1,
        include: {
          steps: {
            orderBy: [{ atMs: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
}

export async function GET(_request: Request, { params }: WorkRouteProps) {
  const access = await getTenantApiAccess("catalog.read");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { workId } = await params;
  const [work, artists, collections] = await Promise.all([
    findTenantWork(access.tenant.id, workId),
    db.artist.findMany({
      where: { tenantId: access.tenant.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, displayName: true },
    }),
    db.collection.findMany({
      where: { tenantId: access.tenant.id, status: { not: "ARCHIVED" } },
      orderBy: { title: "asc" },
      select: { id: true, title: true, slug: true },
    }),
  ]);

  if (!work) {
    return NextResponse.json({ error: "Work not found." }, { status: 404 });
  }

  const sanitizeAsset = <T extends { processingJobs: { lastError: string | null }[] }>(asset: T) => ({
    ...asset,
    processingJobs: asset.processingJobs.map((job) => ({
      ...job,
      lastError: publicStoredError(job.lastError),
    })),
  });
  return NextResponse.json({
    work: {
      ...work,
      audioAssets: work.audioAssets.map(sanitizeAsset),
      stemGroups: work.stemGroups.map((group) => ({
        ...group,
        audioAssets: group.audioAssets.map(sanitizeAsset),
      })),
    },
    artists,
    collections,
  });
}

export async function PATCH(request: Request, { params }: WorkRouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { workId } = await params;
  const existing = await db.work.findFirst({
    where: { id: workId, tenantId: access.tenant.id },
    select: { id: true, status: true },
  });

  if (!existing) {
    return NextResponse.json({ error: "Work not found." }, { status: 404 });
  }

  if (existing.status === "ARCHIVED") {
    return NextResponse.json(
      { error: "Restore the Work before editing it." },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | {
        work?: Record<string, unknown>;
        credits?: CatalogEditorCredit[];
        sections?: CatalogEditorSection[];
        stems?: CatalogEditorStem[];
        collectionIds?: string[];
        reveal?: CatalogEditorReveal | null;
      }
    | null;

  if (!body?.work) {
    return NextResponse.json({ error: "Invalid editor payload." }, { status: 400 });
  }

  try {
    const workInput = normalizeWorkInput(body.work);
    const credits = normalizeCredits(body.credits ?? []);
    const sections = normalizeSections(body.sections ?? []);
    const stems = normalizeStemInputs(body.stems ?? []);
    const reveal = normalizeReveal(body.reveal ?? null);
    const collectionIds = [...new Set(body.collectionIds ?? [])];

    const [artistCount, collectionCount] = await Promise.all([
      workInput.primaryArtistId
        ? db.artist.count({
            where: {
              id: workInput.primaryArtistId,
              tenantId: access.tenant.id,
            },
          })
        : Promise.resolve(1),
      collectionIds.length
        ? db.collection.count({
            where: {
              id: { in: collectionIds },
              tenantId: access.tenant.id,
              status: { not: "ARCHIVED" },
            },
          })
        : Promise.resolve(0),
    ]);

    if (artistCount !== 1) {
      throw new Error("Primary artist does not belong to this tenant.");
    }
    if (collectionCount !== collectionIds.length) {
      throw new Error("One or more Collections do not belong to this tenant.");
    }

    const saved = await db.$transaction(async (tx) => {
      const existingStems = await tx.stemGroup.findMany({
        where: { workId },
        select: {
          id: true,
          _count: { select: { audioAssets: true } },
        },
      });
      const incomingStemIds = new Set(stems.flatMap((stem) => (stem.id ? [stem.id] : [])));
      const deletions = existingStems.filter((stem) => !incomingStemIds.has(stem.id));

      if (deletions.some((stem) => stem._count.audioAssets > 0)) {
        throw new Error(
          "A source group with uploaded audio cannot be deleted. Remove or reassign its audio first.",
        );
      }

      await tx.work.update({
        where: { id: workId },
        data: workInput,
      });

      await tx.workCredit.deleteMany({ where: { workId } });
      if (credits.length) {
        await tx.workCredit.createMany({
          data: credits.map((credit, index) => ({
            workId,
            role: credit.role,
            displayName: credit.displayName,
            position: credit.position ?? index,
          })),
        });
      }

      await tx.workSection.deleteMany({ where: { workId } });
      if (sections.length) {
        await tx.workSection.createMany({
          data: sections.map((section, index) => ({
            workId,
            kind: section.kind,
            title: section.title,
            body: section.body,
            position: section.position ?? index,
          })),
        });
      }

      if (deletions.length) {
        await tx.stemGroup.deleteMany({
          where: { id: { in: deletions.map((stem) => stem.id) }, workId },
        });
      }

      for (let index = 0; index < stems.length; index += 1) {
        const stem = stems[index];
        const data = {
          slug: stem.slug,
          label: stem.label,
          description: stem.description ?? null,
          position: stem.position ?? index,
          isFeatured: Boolean(stem.isFeatured),
        };

        if (stem.id) {
          const updated = await tx.stemGroup.updateMany({
            where: { id: stem.id, workId },
            data,
          });
          if (updated.count !== 1) {
            throw new Error("A source group does not belong to this Work.");
          }
        } else {
          await tx.stemGroup.create({ data: { workId, ...data } });
        }
      }

      await tx.collectionWork.deleteMany({ where: { workId } });
      if (collectionIds.length) {
        await tx.collectionWork.createMany({
          data: collectionIds.map((collectionId, position) => ({
            collectionId,
            workId,
            position,
          })),
        });
      }

      const previousReveal = await tx.revealSequence.findFirst({
        where: { workId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      });

      if (!reveal) {
        await tx.revealSequence.deleteMany({ where: { workId } });
      } else {
        const sequence = previousReveal
          ? await tx.revealSequence.update({
              where: { id: previousReveal.id },
              data: {
                name: reveal.name,
                description: reveal.description ?? null,
                isPublished: Boolean(reveal.isPublished),
                position: 0,
              },
            })
          : await tx.revealSequence.create({
              data: {
                workId,
                name: reveal.name,
                description: reveal.description ?? null,
                isPublished: Boolean(reveal.isPublished),
                position: 0,
              },
            });

        await tx.revealStep.deleteMany({ where: { sequenceId: sequence.id } });

        if (reveal.steps.length) {
          const validStemIds = new Set(
            (
              await tx.stemGroup.findMany({
                where: { workId },
                select: { id: true },
              })
            ).map((stem) => stem.id),
          );

          for (const step of reveal.steps) {
            if (
              (step.action === "ADD_SOURCE" ||
                step.action === "REMOVE_SOURCE") &&
              (!step.stemGroupId || !validStemIds.has(step.stemGroupId))
            ) {
              throw new Error("Reveal step targets an invalid source group.");
            }
          }

          await tx.revealStep.createMany({
            data: reveal.steps.map((step) => ({
              sequenceId: sequence.id,
              stemGroupId: step.stemGroupId,
              atMs: step.atMs,
              action: step.action,
              caption: step.caption ?? null,
            })),
          });
        }
      }

      return tx.work.findUniqueOrThrow({
        where: { id: workId },
        select: { id: true, slug: true, title: true, status: true, updatedAt: true },
      });
    });

    return NextResponse.json({ work: saved });
  } catch (error) {
    const message =
      publicOperationError(error, "Unable to save Work.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: WorkRouteProps) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { workId } = await params;
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown }
    | null;
  const action = typeof body?.action === "string" ? body.action : "";

  const work = await db.work.findFirst({
    where: { id: workId, tenantId: access.tenant.id },
    select: {
      id: true,
      slug: true,
      status: true,
      audioAssets: {
        where: { sourceAssetId: null },
        select: { kind: true, status: true },
      },
    },
  });

  if (!work) {
    return NextResponse.json({ error: "Work not found." }, { status: 404 });
  }

  try {
    if (action === "publish") {
      validatePublishReadiness({
        currentStatus: work.status,
        readyMasterCount: work.audioAssets.filter(
          (asset) => asset.kind === "MASTER" && asset.status === "READY",
        ).length,
        processingSourceCount: work.audioAssets.filter(
          (asset) =>
            asset.status === "PENDING" || asset.status === "PROCESSING",
        ).length,
        failedSourceCount: work.audioAssets.filter(
          (asset) => asset.status === "FAILED",
        ).length,
      });

      const published = await db.work.update({
        where: { id: work.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
        select: { id: true, slug: true, status: true, publishedAt: true },
      });
      return NextResponse.json({ work: published });
    }

    if (action === "unpublish") {
      if (work.status !== "PUBLISHED") {
        throw new Error("Only a published Work can be unpublished.");
      }
      const updated = await db.work.update({
        where: { id: work.id },
        data: { status: "READY" },
        select: { id: true, slug: true, status: true, publishedAt: true },
      });
      return NextResponse.json({ work: updated });
    }

    if (action === "archive") {
      if (work.status === "PUBLISHED") {
        throw new Error("Unpublish the Work before archiving it.");
      }
      const updated = await db.work.update({
        where: { id: work.id },
        data: { status: "ARCHIVED" },
        select: { id: true, slug: true, status: true },
      });
      return NextResponse.json({ work: updated });
    }

    if (action === "restore") {
      if (work.status !== "ARCHIVED") {
        throw new Error("Only an archived Work can be restored.");
      }
      const updated = await db.work.update({
        where: { id: work.id },
        data: { status: "DRAFT", publishedAt: null },
        select: { id: true, slug: true, status: true },
      });
      return NextResponse.json({ work: updated });
    }

    throw new Error("Unsupported Work action.");
  } catch (error) {
    const message =
      publicOperationError(error, "Unable to update Work status.");
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
