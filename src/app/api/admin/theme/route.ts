import { publicOperationError } from "@/lib/public-operation-error";
import { NextResponse } from "next/server";

import { getTenantApiAccess } from "@/lib/access";
import { assertTenantCanUseWhiteLabel } from "@/lib/billing";
import { db } from "@/lib/db";
import {
  availableThemePresets,
  getResolvedTenantTheme,
  getThemePreset,
  normalizeThemeDraft,
} from "@/lib/theme";

export async function GET() {
  const access = await getTenantApiAccess("catalog.read");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const theme = await getResolvedTenantTheme(access.tenant.id);
  return NextResponse.json({
    theme,
    presets: availableThemePresets(),
    assetUrls: {
      logo: theme.logoAssetId ? "/api/theme/logo" : null,
      favicon: theme.faviconAssetId ? "/api/theme/favicon" : null,
    },
  });
}

export async function PATCH(request: Request) {
  const access = await getTenantApiAccess("catalog.write");
  if (!access) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await request.json().catch(() => null);

  try {
    await assertTenantCanUseWhiteLabel(access.tenant.id);
    const current = await getResolvedTenantTheme(access.tenant.id);
    const applyPreset = body?.action === "apply-preset";

    const normalized = applyPreset
      ? getThemePreset(String(body?.preset ?? "") as Parameters<typeof getThemePreset>[0])
      : normalizeThemeDraft(
          { ...(body ?? {}), preset: "CUSTOM" },
          current,
        );

    const saved = await db.tenantTheme.upsert({
      where: { tenantId: access.tenant.id },
      create: {
        tenantId: access.tenant.id,
        ...normalized,
      },
      update: normalized,
    });

    return NextResponse.json({ theme: saved });
  } catch (error) {
    return NextResponse.json(
      { error: publicOperationError(error, "Unable to save theme.") },
      { status: 400 },
    );
  }
}
