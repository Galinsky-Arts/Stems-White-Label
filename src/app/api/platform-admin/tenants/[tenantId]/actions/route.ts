import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getPlatformAccess } from "@/lib/platform-access";
import {
  removeTenantFeatureFlag,
  retryFailedDownloadPackage,
  retryFailedProcessingJob,
  setTenantFeatureFlag,
  updatePlatformTenantStatus,
  updateTenantPlatformFee,
} from "@/lib/platform-admin";

type RouteProps = { params: Promise<{ tenantId: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const access = await getPlatformAccess();
  if (!access) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { tenantId } = await params;
  const body = await request.json().catch(() => null);
  const action = String(body?.action ?? "");
  const actor = {
    id: access.user.id,
    email: access.user.email,
  };

  try {
    if (action === "tenant-status") {
      const status =
        body?.status === "ACTIVE" || body?.status === "SUSPENDED"
          ? body.status
          : null;
      if (!status) throw new Error("Unsupported tenant status.");
      await updatePlatformTenantStatus({
        actor,
        tenantId,
        status,
        reason: body?.reason,
      });
    } else if (action === "platform-fee") {
      await updateTenantPlatformFee({
        actor,
        tenantId,
        platformFeeBps: body?.platformFeeBps,
        reason: body?.reason,
      });
    } else if (action === "set-feature") {
      await setTenantFeatureFlag({
        actor,
        tenantId,
        key: body?.key,
        enabled: body?.enabled,
        note: body?.note,
        reason: body?.reason,
      });
    } else if (action === "remove-feature") {
      await removeTenantFeatureFlag({
        actor,
        tenantId,
        key: body?.key,
        reason: body?.reason,
      });
    } else if (action === "retry-processing") {
      await retryFailedProcessingJob({
        actor,
        tenantId,
        jobId: String(body?.jobId ?? ""),
        reason: body?.reason,
      });
    } else if (action === "retry-package") {
      await retryFailedDownloadPackage({
        actor,
        tenantId,
        packageId: String(body?.packageId ?? ""),
        reason: body?.reason,
      });
    } else {
      return NextResponse.json(
        { error: "Unsupported platform action." },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          publicOperationError(error, "Unable to perform platform action."),
      },
      { status: 400 },
    );
  }
}
