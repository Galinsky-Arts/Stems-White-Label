export function safeInternalCallback(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try {
    const url = new URL(value, "https://callback.invalid");
    return url.origin === "https://callback.invalid" ? value : null;
  } catch { return null; }
}
