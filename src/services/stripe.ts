import Stripe from "stripe";
import { ApiError } from "../core/errors";

let stripeClient: Stripe | null = null;

export function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new ApiError(500, "STRIPE_NOT_CONFIGURED", "Stripe secret key is not configured");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    throw new ApiError(500, "STRIPE_WEBHOOK_NOT_CONFIGURED", "Stripe webhook secret is not configured");
  }

  return secret;
}

function normalizeStripeInterval(value: string) {
  const normalized = value.trim().toLowerCase();

  if (["month", "monthly", "mois"].includes(normalized)) {
    return "month" as const;
  }

  if (["year", "yearly", "annual", "annuel"].includes(normalized)) {
    return "year" as const;
  }

  throw new ApiError(500, "STRIPE_INTERVAL_NOT_SUPPORTED", `Unsupported Stripe billing interval: ${value}`);
}

export async function getOrCreateStripePriceForPlan(plan: {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  currency: string;
  billing_interval: string;
}) {
  const stripe = getStripeClient();
  const recurringInterval = normalizeStripeInterval(plan.billing_interval);
  const lookupKey = `jobizy-plan-${plan.code}-${plan.currency.toLowerCase()}-${recurringInterval}-${plan.price_cents}`;
  const existingPrices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });

  if (existingPrices.data[0]?.id) {
    return existingPrices.data[0].id;
  }

  const createdPrice = await stripe.prices.create({
    lookup_key: lookupKey,
    currency: plan.currency.toLowerCase(),
    unit_amount: plan.price_cents,
    recurring: {
      interval: recurringInterval,
    },
    product_data: {
      name: `Jobizy ${plan.name}`,
      metadata: {
        local_plan_id: plan.id,
        plan_code: plan.code,
      },
    },
    metadata: {
      local_plan_id: plan.id,
      plan_code: plan.code,
    },
  });

  return createdPrice.id;
}
