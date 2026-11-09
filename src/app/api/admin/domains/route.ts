import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import {
  listTenantDomains,
  registerTenantDomain,
} from "@/lib/domain-service";

export async function GET() {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const domains = await listTenantDomains(access.tenant.id);
  return NextResponse.json({ domains });
}

export async function POST(request: Request) {
  const access = await getTenantApiAccess("tenant.manage");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await request.json().catch(() => null);

  try {
    const domain = await registerTenantDomain(
      access.tenant.id,
      String(body?.hostname ?? ""),
    );
    const domains = await listTenantDomains(access.tenant.id);
    return NextResponse.json(
      {
        domain: domains.find((entry) => entry.id === domain.id) ?? domain,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to register domain.") },
      { status: 400 },
    );
  }
}
