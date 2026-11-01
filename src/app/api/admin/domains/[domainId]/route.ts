import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  deleteTenantDomain,
  listTenantDomains,
  makeTenantDomainPrimary,
  verifyTenantDomain,
} from "@/lib/domain-service";

type RouteProps = { params: Promise<{ domainId: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { domainId } = await params;
  const body = await request.json().catch(() => null);

  try {
    if (body?.action === "verify") {
      await verifyTenantDomain(access.tenant.id, domainId);
    } else if (body?.action === "make-primary") {
      await makeTenantDomainPrimary(access.tenant.id, domainId);
    } else {
      return NextResponse.json({ error: "Unsupported domain action." }, { status: 400 });
    }

    const domains = await listTenantDomains(access.tenant.id);
    const domain = domains.find((entry) => entry.id === domainId);
    if (!domain) return NextResponse.json({ error: "Domain not found." }, { status: 404 });

    return NextResponse.json({ domain });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to update domain.") },
      { status: 400 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteProps) {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { domainId } = await params;

  try {
    await deleteTenantDomain(access.tenant.id, domainId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to delete domain.") },
      { status: 400 },
    );
  }
}
