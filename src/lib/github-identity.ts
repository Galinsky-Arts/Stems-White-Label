export function selectVerifiedGithubEmail(value: unknown) {
  if (!Array.isArray(value)) return null;
  const addresses = value.filter((entry): entry is { email: string; primary?: boolean; verified: true } =>
    Boolean(entry && typeof entry === "object" && entry.verified === true &&
      typeof entry.email === "string" && entry.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)),
  );
  const selected = addresses.find((entry) => entry.primary === true) ?? addresses[0];
  return selected?.email.trim().toLowerCase() ?? null;
}

export async function verifiedGithubProfile(
  profile: Record<string, unknown>,
  accessToken: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  if (!accessToken) throw new Error("GitHub identity verification failed.");
  const response = await fetcher("https://api.github.com/user/emails", {
    headers: { Authorization: "token " + accessToken, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("GitHub identity verification failed.");
  const email = selectVerifiedGithubEmail(await response.json());
  if (!email) throw new Error("A verified GitHub email is required.");
  return { ...profile, email, email_verified: true };
}
