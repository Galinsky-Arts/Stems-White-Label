/** Parse one HTTP Host value; proxy lists and URL syntax fail closed. */
export function parseRequestHostname(value: string): string | null {
  if (!value || /[\s,/@\\?#]/.test(value)) return null;
  try {
    const url = new URL("http://" + value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "[::1]") return "::1";
    if (!host || host.length > 253) return null;
    if (!host.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return host;
  } catch { return null; }
}
