import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GithubProvider from "next-auth/providers/github";

import { verifiedGithubProfile } from "./github-identity";

import { db } from "@/lib/db";
import { getCurrentTenant } from "@/lib/tenant";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  session: { strategy: "database", maxAge: 24 * 60 * 60, updateAge: 60 * 60 },
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_ID ?? "",
      clientSecret: process.env.GITHUB_SECRET ?? "",
      userinfo: {
        url: "https://api.github.com/user",
        async request({ client, tokens }) {
          const profile = await client.userinfo(tokens.access_token!);
          return verifiedGithubProfile(profile, tokens.access_token);
        },
      },
    }),
    EmailProvider({
      server: process.env.EMAIL_SERVER ?? "",
      from: process.env.EMAIL_FROM ?? "",
      maxAge: 20 * 60,
    }),
  ],
  callbacks: {
    async signIn({ user, account, email }) {
      if (email || account?.provider === "email") {
        if (!user.email) return false;
        const tenant = await getCurrentTenant();
        if (!tenant) return false;

        const normalizedEmail = user.email.trim().toLowerCase();
        const [customer, invitation, membership] = await Promise.all([
          db.customer.findUnique({
            where: {
              tenantId_normalizedEmail: {
                tenantId: tenant.id,
                normalizedEmail,
              },
            },
            select: { id: true },
          }),
          db.tenantInvitation.findFirst({
            where: {
              tenantId: tenant.id,
              normalizedEmail,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          }),
          db.tenantMembership.findFirst({
            where: { tenantId: tenant.id, user: { email: { equals: normalizedEmail, mode: "insensitive" } } },
            select: { id: true },
          }),
        ]);

        return Boolean(customer || invitation || membership);
      }

      return true;
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "github" && profile && "email_verified" in profile && profile.email_verified === true &&
          typeof profile.email === "string" && user.email &&
          profile.email.trim().toLowerCase() === user.email.trim().toLowerCase()) {
        await db.user.updateMany({
          where: { id: user.id, email: user.email },
          data: { emailVerified: new Date() },
        });
      }
    },
  },
  pages: {
    signIn: "/auth/sign-in",
    verifyRequest: "/auth/verify-request",
  },
};
