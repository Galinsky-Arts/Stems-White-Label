import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function AccountPasswordPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/auth/sign-in?callbackUrl=/account/password");
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true, passwordFromBootstrap: true },
  });

  return (
    <main className="cms-shell">
      <header className="cms-dashboard-header">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Password</h1>
          <p>
            {user?.passwordFromBootstrap
              ? "You are using the bootstrap password from the server setting. Choose your own password now; the bootstrap value will no longer override it."
              : user?.passwordHash
                ? "Change your sign-in password. Other signed-in sessions are signed out."
                : "Set a password so you can sign in with email and password."}
          </p>
        </div>
      </header>
      <ChangePasswordForm requireCurrent={Boolean(user?.passwordHash)} />
    </main>
  );
}
