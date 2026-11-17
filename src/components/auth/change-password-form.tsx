"use client";

import { useState } from "react";

export function ChangePasswordForm({ requireCurrent }: { requireCurrent: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirm) {
      setMessage("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(response.ok ? "Password updated." : body.error ?? "Unable to update password.");
      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirm("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="customer-signin__form" onSubmit={submit} aria-label="Change password">
      {requireCurrent ? (
        <label>
          <span>Current password</span>
          <input autoComplete="current-password" required type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
      ) : null}
      <label>
        <span>New password (at least 12 characters)</span>
        <input autoComplete="new-password" minLength={12} required type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </label>
      <label>
        <span>Confirm new password</span>
        <input autoComplete="new-password" minLength={12} required type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </label>
      <button className="purchase-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save password"}</button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
