"use client";

import { useState } from "react";

export function PasswordSignIn({ callbackUrl }: { callbackUrl: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, callbackUrl }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Unable to sign in.");
        return;
      }
      window.location.assign(body.redirect ?? "/admin");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="customer-signin__form" onSubmit={submit} aria-label="Sign in with email and password">
      <label>
        <span>Email</span>
        <input autoComplete="username" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        <span>Password</span>
        <input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button className="purchase-button" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
      {error ? <p className="cart-review__error" role="alert">{error}</p> : null}
    </form>
  );
}
