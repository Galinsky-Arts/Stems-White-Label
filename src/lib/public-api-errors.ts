/** Public analytics endpoints must never reflect database or provider diagnostics. */
const allowed = new Set([
  "Unsupported analytics event type.",
  "Invalid analytics event ID.",
  "Invalid analytics playback position.",
  "Work is required.",
  "Source group does not belong to this Work.",
]);
export function publicAnalyticsError(error: unknown): string {
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : "Unable to record analytics event.";
}
