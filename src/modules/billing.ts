import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../core/auth";
import { execute, hasColumn, query, queryOne, withTransaction } from "../core/db";
import { ApiError } from "../core/errors";
import { asyncHandler, created, ok } from "../core/http";
import { createId } from "../core/store";
import { sendEventEmail } from "../services/email";
import { createInAppNotification, writeAuditLog } from "../services/request-publication";
import { getOrCreateStripePriceForPlan, getStripeClient } from "../services/stripe";

const cancelSchema = z.object({
  cancellation_reason: z.string().max(100).nullable().optional(),
  cancellation_note: z.string().max(1000).nullable().optional(),
});

export function billingRouter() {
  const router = Router();

  // ── GET /plans ────────────────────────────────────────────────────────────────
  router.get(
    "/plans",
    asyncHandler(async (_req, res) => {
      const plans = await query(
        `SELECT id, code, name, badge, max_responses, response_limit,
                priority_level, price_cents, currency, billing_interval, status
           FROM plans
          WHERE status = 'active'
          ORDER BY price_cents ASC`,
      );
      return ok(res, plans);
    }),
  );

  // ── GET /subscriptions ────────────────────────────────────────────────────────
  router.get(
    "/subscriptions",
    authRequired,
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const hasCancelCol = await hasColumn("subscriptions", "cancel_at_period_end");
      const cancelSelect = hasCancelCol ? "s.cancel_at_period_end" : "0 AS cancel_at_period_end";

      const rows = await query(
        `SELECT s.id, s.user_id, s.provider_profile_id, s.plan_id, s.status, s.starts_at, s.ends_at,
                ${cancelSelect},
                p.code AS plan_code, p.name AS plan_name,
                p.price_cents, p.currency, p.billing_interval,
                p.response_limit, p.priority_level
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = ?
          ORDER BY s.created_at DESC`,
        [userId],
      );

      return ok(res, rows);
    }),
  );

  // ── POST /subscriptions/checkout ──────────────────────────────────────────────
  router.post(
    "/subscriptions/checkout",
    authRequired,
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const { plan_id } = req.body as { plan_id?: string };

      if (!plan_id) {
        throw new ApiError(400, "PLAN_ID_REQUIRED", "plan_id is required");
      }

      const plan = await queryOne<{
        id: string;
        code: string;
        name: string;
        price_cents: number;
        currency: string;
        billing_interval: string;
        status: string;
      }>(
        `SELECT id, code, name, price_cents, currency, billing_interval, status FROM plans WHERE id = ?`,
        [plan_id],
      );

      if (!plan || plan.status !== "active") {
        throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found or inactive");
      }

      const providerProfile = await queryOne<{ id: string }>(
        `SELECT id FROM provider_profiles WHERE user_id = ? LIMIT 1`,
        [userId],
      );

      if (!providerProfile) {
        throw new ApiError(400, "NO_PROVIDER_PROFILE", "Provider profile required to subscribe");
      }

      // Free plan — activate locally, no Stripe
      if (plan.price_cents === 0) {
        const subscriptionId = createId("sub");
        await withTransaction(async (conn) => {
          await conn.execute(
            `UPDATE subscriptions
                SET status = 'cancelled', updated_at = NOW()
              WHERE user_id = ?
                AND status IN ('draft', 'active', 'trial', 'past_due')`,
            [userId],
          );
          await conn.execute(
            `INSERT INTO subscriptions
               (id, user_id, provider_profile_id, plan_id, status, starts_at)
             VALUES (?, ?, ?, ?, 'active', NOW())`,
            [subscriptionId, userId, providerProfile.id, plan.id],
          );
        });

        const subscription = await queryOne(
          `SELECT s.*, p.code AS plan_code, p.name AS plan_name
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
            WHERE s.id = ?`,
          [subscriptionId],
        );
        return created(res, { subscription, checkout_url: null });
      }

      // Paid plan — create Stripe checkout session
      const priceId = await getOrCreateStripePriceForPlan(plan);
      const subscriptionId = createId("sub");

      await withTransaction(async (conn) => {
        await conn.execute(
          `INSERT INTO subscriptions
             (id, user_id, provider_profile_id, plan_id, status)
           VALUES (?, ?, ?, ?, 'draft')`,
          [subscriptionId, userId, providerProfile.id, plan.id],
        );
      });

      const locale = req.header("Accept-Language")?.includes("en-CA") ? "en-CA" : "fr-CA";
      const frontendUrl = (process.env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, "");
      const body = req.body as { plan_id?: string; success_url?: string; cancel_url?: string };
      const successUrl = body.success_url ?? `${frontendUrl}/${locale}/pro/abonnement?checkout=success`;
      const cancelUrl = body.cancel_url ?? `${frontendUrl}/${locale}/pro/abonnement?checkout=cancel`;

      const session = await getStripeClient().checkout.sessions.create({
        mode: "subscription",
        customer_email: req.user!.email,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          local_subscription_id: subscriptionId,
          user_id: userId,
        },
        subscription_data: {
          metadata: {
            local_subscription_id: subscriptionId,
            user_id: userId,
          },
        },
      });

      return created(res, { subscription: null, checkout_url: session.url });
    }),
  );

  // ── POST /billing/subscriptions/:id/cancel ────────────────────────────────────
  router.post(
    "/billing/subscriptions/:id/cancel",
    authRequired,
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const subscriptionId = req.params.id;
      const payload = cancelSchema.parse(req.body);

      const [hasStripeCol, hasCancelCol, hasCancelledAt, hasCancelBy, hasCancelReason, hasCancelNote] = await Promise.all([
        hasColumn("subscriptions", "stripe_subscription_id"),
        hasColumn("subscriptions", "cancel_at_period_end"),
        hasColumn("subscriptions", "cancelled_at"),
        hasColumn("subscriptions", "cancelled_by_user_id"),
        hasColumn("subscriptions", "cancellation_reason"),
        hasColumn("subscriptions", "cancellation_note"),
      ]);

      const stripeColSelect = hasStripeCol ? "stripe_subscription_id" : "NULL AS stripe_subscription_id";
      const subscription = await queryOne<{
        id: string;
        user_id: string;
        status: string;
        stripe_subscription_id: string | null;
      }>(
        `SELECT id, user_id, status, ${stripeColSelect}
           FROM subscriptions
          WHERE id = ? AND user_id = ?`,
        [subscriptionId, userId],
      );

      if (!subscription) {
        throw new ApiError(404, "SUBSCRIPTION_NOT_FOUND", "Subscription not found");
      }
      if (subscription.status === "cancelled") {
        throw new ApiError(409, "ALREADY_CANCELLED", "Subscription is already cancelled");
      }

      if (subscription.stripe_subscription_id) {
        // Cancel at period end via Stripe — keeps subscription active until end of billing cycle
        await getStripeClient().subscriptions.update(subscription.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
        const stripeAssignments: string[] = [];
        const stripeParams: unknown[] = [];
        if (hasCancelCol)    stripeAssignments.push(`cancel_at_period_end = 1`);
        if (hasCancelBy)     { stripeAssignments.push(`cancelled_by_user_id = ?`); stripeParams.push(userId); }
        if (hasCancelReason) { stripeAssignments.push(`cancellation_reason = ?`); stripeParams.push(payload.cancellation_reason ?? null); }
        if (hasCancelNote)   { stripeAssignments.push(`cancellation_note = ?`); stripeParams.push(payload.cancellation_note ?? null); }
        stripeAssignments.push(`updated_at = NOW()`);
        await execute(
          `UPDATE subscriptions SET ${stripeAssignments.join(", ")} WHERE id = ?`,
          [...stripeParams, subscriptionId],
        );
      } else {
        // Local subscription (free plan) — cancel immediately
        const localAssignments: string[] = [`status = 'cancelled'`, `ends_at = NOW()`];
        const localParams: unknown[] = [];
        if (hasCancelledAt)  localAssignments.push(`cancelled_at = NOW()`);
        if (hasCancelBy)     { localAssignments.push(`cancelled_by_user_id = ?`); localParams.push(userId); }
        if (hasCancelReason) { localAssignments.push(`cancellation_reason = ?`); localParams.push(payload.cancellation_reason ?? null); }
        if (hasCancelNote)   { localAssignments.push(`cancellation_note = ?`); localParams.push(payload.cancellation_note ?? null); }
        localAssignments.push(`updated_at = NOW()`);
        await execute(
          `UPDATE subscriptions SET ${localAssignments.join(", ")} WHERE id = ?`,
          [...localParams, subscriptionId],
        );
      }

      const isStripe = !!subscription.stripe_subscription_id;
      await createInAppNotification(
        null,
        userId,
        "subscription_cancelled",
        "Abonnement en cours d'annulation",
        isStripe
          ? "Votre abonnement restera actif jusqu'a la fin de la periode en cours."
          : "Votre abonnement a ete annule immediatement.",
      );
      void sendEventEmail({
        userId,
        type: "subscription_cancelled",
        title: "Abonnement annule",
        body: isStripe
          ? "Votre abonnement restera actif jusqu'a la fin de la periode de facturation en cours, puis ne sera pas renouvele."
          : "Votre abonnement a ete annule immediatement.",
      });

      await writeAuditLog(
        null,
        userId,
        "subscription",
        subscriptionId,
        isStripe ? "cancel_at_period_end" : "cancelled",
        {
          cancellation_reason: payload.cancellation_reason ?? null,
          cancellation_note: payload.cancellation_note ?? null,
          stripe: isStripe,
        },
        req.ip ?? null,
      );

      const updated = await queryOne(
        `SELECT s.*, p.code AS plan_code, p.name AS plan_name
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.id = ?`,
        [subscriptionId],
      );

      return ok(res, updated);
    }),
  );

  return router;
}
