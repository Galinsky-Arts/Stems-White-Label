"use client";

import { useEffect, useState } from "react";

type FlaggedOrder = {
  id: string;
  buyerEmail: string | null;
  totalCents: number;
  currency: string;
  reconciliation: "NEEDS_REVIEW" | "REFUND_REQUESTED" | "RESOLVED" | null;
  reconciliationNote: string | null;
  reconciliationFlaggedAt: string | null;
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

export function PaymentReconciliationPanel({ canManage }: { canManage: boolean }) {
  const [orders, setOrders] = useState<FlaggedOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/commerce/reconciliation", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => setOrders(body.orders ?? []))
      .catch(() => setError("Unable to load orders needing review."));
  }, []);

  async function act(orderId: string, action: "refund" | "resolve") {
    let note: string | null = null;
    if (action === "resolve") {
      note = window.prompt("How was this payment resolved? (required)");
      if (!note) return;
    } else if (!window.confirm("Refund this payment in full through Stripe? The buyer never received access.")) {
      return;
    }
    setBusy(orderId);
    setError(null);
    try {
      const response = await fetch("/api/admin/commerce/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, action, note }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Action failed.");
      setOrders(body.orders);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="cms-panel" aria-labelledby="reconciliation-heading">
      <h2 id="reconciliation-heading">Payments on canceled orders</h2>
      <p>
        If a buyer pays after their order was canceled (for example an expired
        checkout that completed late), no license or download is granted. The
        order appears here so you can refund it. Set
        <code> STEMS_AUTO_REFUND_CANCELED_PAYMENTS=true</code> to refund these automatically.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {orders === null ? <p>Loading…</p> : orders.length === 0 ? (
        <p>No payments need review.</p>
      ) : (
        <table>
          <caption>Orders needing reconciliation</caption>
          <thead>
            <tr><th scope="col">Order</th><th scope="col">Buyer</th><th scope="col">Amount</th><th scope="col">State</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td><code>{order.id}</code></td>
                <td>{order.buyerEmail ?? "Unknown"}</td>
                <td>{money(order.totalCents, order.currency)}</td>
                <td>{order.reconciliation === "REFUND_REQUESTED" ? "Refund requested" : "Needs review"}<br /><small>{order.reconciliationNote}</small></td>
                <td>
                  {canManage ? (
                    <>
                      <button type="button" disabled={busy === order.id || order.reconciliation === "REFUND_REQUESTED"} onClick={() => act(order.id, "refund")}>Refund</button>{" "}
                      <button type="button" disabled={busy === order.id} onClick={() => act(order.id, "resolve")}>Mark resolved</button>
                    </>
                  ) : "Owner or admin required"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
