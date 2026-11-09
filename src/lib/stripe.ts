import Stripe from "stripe";

let stripe: Stripe | null = null;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");

  if (!stripe) stripe = new Stripe(secretKey, { timeout: 5000, maxNetworkRetries: 1 });
  return stripe;
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
