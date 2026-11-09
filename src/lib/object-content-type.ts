const passiveTypes = new Set([
  "application/octet-stream", "application/json", "application/zip",
  "audio/wav", "audio/x-wav", "audio/aiff", "audio/x-aiff", "audio/flac", "audio/x-flac", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/x-caf",
  "image/jpeg", "image/png", "image/webp", "image/x-icon", "image/vnd.microsoft.icon",
]);

/** Object metadata cannot turn a same-origin media endpoint into active content. */
export function safeObjectContentType(value: string | null | undefined) {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return passiveTypes.has(type) ? type : "application/octet-stream";
}
