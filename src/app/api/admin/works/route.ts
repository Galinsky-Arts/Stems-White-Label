import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { assertTenantCanCreateWork } from "@/lib/billing";
import { normalizeWorkInput } from "@/lib/catalog-cms";
import { db } from "@/lib/db";

export async function GET() {
  const access = await getTenantApiAccess("catalog.read");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const works = await db.work.findMany({
    where: { tenantId: access.tenant.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      updatedAt: true,
      publishedAt: true,
      _count: {
        select: {
          stemGroups: true,
          audioAssets: true,
        },
      },
    },
  });

  return NextResponse.json({ works });
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    await assertTenantCanCreateWork(access.tenant.id);
    const input = normalizeWorkInput(body);

    if (input.primaryArtistId) {
      const artist = await db.artist.findFirst({
        where: { id: input.primaryArtistId, tenantId: access.tenant.id },
        select: { id: true },
      });
      if (!artist) {
        return NextResponse.json({ error: "Artist not found." }, { status: 400 });
      }
    }

    const work = await db.work.create({
      data: {
        tenantId: access.tenant.id,
        ...input,
        status: "DRAFT",
      },
      select: { id: true, slug: true, title: true, status: true },
    });

    return NextResponse.json({ work }, { status: 201 });
  } catch (error) {
    const message =
      publicOperationError(error, "Unable to create Work.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
