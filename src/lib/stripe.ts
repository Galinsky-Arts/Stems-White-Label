import Stripe from "stripe";

let stripe: Stripe | null = null;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");

  if (!stripe) stripe = new Stripe(secretKey, { timeout: 5000, maxNetworkRetries: 1, ...localStripeApiOverride() });
  return stripe;
}

/**
 * Test-only: STRIPE_API_BASE points the SDK at fixtures/stripe-mock. Ignored in
 * production and for any non-loopback host, so it can never redirect live
 * payment API traffic or credentials.
 */
export function localStripeApiOverride(
  base = process.env.STRIPE_API_BASE,
  nodeEnv = process.env.NODE_ENV,
): { host: string; port: number; protocol: "http" | "https" } | Record<string, never> {
  if (!base || nodeEnv === "production") return {};
  let url: URL;
  try { url = new URL(base); } catch { return {}; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return {};
  const protocol = url.protocol === "https:" ? "https" : "http";
  return { host: url.hostname, port: Number(url.port || (protocol === "https" ? 443 : 80)), protocol };
}

/** Test-only: drop the cached client so a new STRIPE_API_BASE takes effect. */
export function resetStripeClientForTests() {
  stripe = null;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  return secret;
}


export function getStripeConnectWebhookSecret() {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET is not configured.");
  return secret;
}


export function getStripeBillingWebhookSecret() {
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_BILLING_WEBHOOK_SECRET is not configured.");
  return secret;
}
