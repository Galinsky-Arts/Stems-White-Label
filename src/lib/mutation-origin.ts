export function mutationOriginAllowed(input: {
  origin: string | null;
  host: string | null;
  requestUrl: string;
  production: boolean;
  fetchSite?: string | null;
}) {
  if (!input.origin || !input.host || input.fetchSite === "cross-site") return false;
  if (/[\s,/@\\?#]/.test(input.host)) return false;
  try {
    const expected = new URL((input.production ? "https://" : new URL(input.requestUrl).protocol + "//") + input.host);
    const origin = new URL(input.origin);
    return !origin.username && !origin.password && input.origin === origin.origin &&
      origin.origin === expected.origin && expected.pathname === "/";
  } catch { return false; }
}
