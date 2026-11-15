/**
 * Offline Stripe test double: signed webhook events plus a loopback HTTP server
 * for the few Stripe API reads the app performs. No network, keys or charges.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export const MOCK_WEBHOOK_SECRET = "whsec_stripe_mock_fixture";
export const MOCK_SECRET_KEY = "sk_test_stripe_mock_fixture";

export type MockEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

let counter = 0;
export function eventId(prefix = "evt_mock") {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function signedRequest(event: MockEvent, secret = MOCK_WEBHOOK_SECRET, url = "https://store.example/api/stripe/webhook") {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request(url, { method: "POST", body: payload, headers: { "stripe-signature": signature, "content-type": "application/json" } });
}

export function checkoutCompleted(input: {
  sessionId: string; orderId: string; tenantId: string; paymentIntentId: string;
  amountCents: number; currency?: string; email: string; id?: string;
}): MockEvent {
  return { id: input.id ?? eventId(), type: "checkout.session.completed", data: { object: {
    id: input.sessionId, object: "checkout.session", mode: "payment", payment_status: "paid",
    amount_total: input.amountCents, currency: input.currency ?? "usd", customer: "cus_mock",
    customer_details: { email: input.email, name: "Mock Buyer" }, payment_intent: input.paymentIntentId,
    metadata: { orderId: input.orderId, tenantId: input.tenantId },
  } } };
}

export function refundEvent(input: {
  refundId: string; paymentIntentId: string; amountCents: number;
  type?: "refund.created" | "refund.updated"; status?: string; id?: string;
}): MockEvent {
  return { id: input.id ?? eventId(), type: input.type ?? "refund.created", data: { object: {
    id: input.refundId, object: "refund", payment_intent: input.paymentIntentId,
    amount: input.amountCents, status: input.status ?? "succeeded", reason: "requested_by_customer",
  } } };
}

export type StripeMock = {
  baseUrl: string;
  paymentIntents: Map<string, { metadata: Record<string, string> }>;
  requests: string[];
  close: () => Promise<void>;
};

/** Loopback server answering GET /v1/payment_intents/:id like the Stripe API. */
export async function startStripeMock(): Promise<StripeMock> {
  const paymentIntents = new Map<string, { metadata: Record<string, string> }>();
  const requests: string[] = [];
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "request-id": "req_mock" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method} ${request.url}`);
    if (!String(request.headers.authorization ?? "").startsWith("Bearer sk_test_")) {
      return send(response, 401, { error: { type: "invalid_request_error", message: "Invalid API key." } });
    }
    const match = /^\/v1\/payment_intents\/([A-Za-z0-9_]+)$/.exec(request.url ?? "");
    const intent = match && request.method === "GET" ? paymentIntents.get(match[1]!) : undefined;
    if (!intent) return send(response, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent." } });
    return send(response, 200, { id: match![1], object: "payment_intent", status: "succeeded", metadata: intent.metadata });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    paymentIntents,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
