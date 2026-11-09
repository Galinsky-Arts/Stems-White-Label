import assert from "node:assert/strict";
import test from "node:test";
import { selectVerifiedGithubEmail, verifiedGithubProfile } from "./github-identity";

test("GitHub identity accepts only provider-verified addresses", () => {
  assert.equal(selectVerifiedGithubEmail([{ email: "unverified@example.com", primary: true, verified: false }, { email: "Verified@Example.com", verified: true }]), "verified@example.com");
  assert.equal(selectVerifiedGithubEmail([{ email: "a@example.com", verified: true }, { email: "primary@example.com", primary: true, verified: true }]), "primary@example.com");
  for (const value of [null, {}, [], [{ email: "a@example.com", verified: "true" }], [{ email: "a@example.com", verified: false }], [{ email: "bad\r\n@example.com", verified: true }]]) assert.equal(selectVerifiedGithubEmail(value), null);
});

test("GitHub profile verification uses the fixed provider endpoint and fails closed", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.github.com/user/emails");
    assert.equal((options?.headers as Record<string, string>).Authorization, "token offline-fixture");
    calls++; return Response.json([{ email: "verified@example.com", verified: true }]);
  };
  const profile = await verifiedGithubProfile({ id: 1, email: "unverified@example.com" }, "offline-fixture", fakeFetch);
  assert.equal(profile.email, "verified@example.com"); assert.equal(profile.email_verified, true); assert.equal(calls, 1);
  await assert.rejects(verifiedGithubProfile({}, undefined, fakeFetch));
  await assert.rejects(verifiedGithubProfile({}, "offline-fixture", async () => new Response("", { status: 403 })));
  await assert.rejects(verifiedGithubProfile({}, "offline-fixture", async () => Response.json([{ email: "unverified@example.com", verified: false }])));
});
