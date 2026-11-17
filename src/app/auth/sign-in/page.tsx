import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { CustomerEmailSignIn } from "@/components/auth/customer-email-sign-in";
import { PasswordSignIn } from "@/components/auth/password-sign-in";
import { safeInternalCallback } from "@/lib/internal-callback";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentTenant } from "@/lib/tenant";

type PageProps = {
  searchParams: Promise<{ callbackUrl?: string }>;
};

export default async function SignInPage({ searchParams }: PageProps) {
  const [session, tenant, params] = await Promise.all([
    getServerSession(authOptions),
    getCurrentTenant(),
    searchParams,
  ]);
  const callbackUrl = safeInternalCallback(params.callbackUrl) ?? "/library";

  if (session?.user?.id) {
    if (safeInternalCallback(params.callbackUrl)) {
      redirect(callbackUrl);
    }

    if (tenant) {
      const membership = await db.tenantMembership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: tenant.id,
            userId: session.user.id,
          },
        },
        select: { id: true },
      });
      redirect(membership ? "/admin" : "/library");
    }

    redirect("/");
  }

  return (
    <main className="storefront-shell customer-signin">
      <section className="customer-signin__customer">
        <p className="micro-label">Customer library</p>
        <h1>Return to your source material.</h1>
        <p>
          Sign in with the email address used at checkout. Access uses a
          single-use email link (requires the store&apos;s email delivery to be
          configured).
        </p>
        <CustomerEmailSignIn callbackUrl={callbackUrl} />
      </section>

      <aside className="customer-signin__admin">
        <p className="micro-label">Artist administration</p>
        <h2>Catalog staff</h2>
        <p>
          Sign in with your email and password. The owner&apos;s first password
          is provisioned from the server setting
          <code> STEMS_BOOTSTRAP_ADMIN_PASSWORD</code>; change it after signing
          in at Account → Password.
        </p>
        <PasswordSignIn callbackUrl={safeInternalCallback(params.callbackUrl) ?? "/admin"} />
        {process.env.GITHUB_ID ? (
          <p>
            <a className="text-link" href="/api/auth/signin/github?callbackUrl=/admin">
              Continue with GitHub
            </a>
          </p>
        ) : null}
      </aside>
    </main>
  );
}
