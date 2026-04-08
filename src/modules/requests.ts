import { Router } from "express";
import { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { authRequired } from "../core/auth";
import { execute, hasColumn, query, queryOne, withTransaction } from "../core/db";
import { ApiError } from "../core/errors";
import { asyncHandler, created, ok } from "../core/http";
import { createId } from "../core/store";
import { sendEventEmail } from "../services/email";
import {
  ensurePushSubscriptionsTable,
  getVapidPublicKey,
  removeUserPushSubscription,
  sendPushToUser,
  upsertPushSubscription,
} from "../services/push";
import { completeReferralOnFirstPublish } from "../services/referral";
import { writeAuditLog } from "../services/request-publication";
import { getOrCreateStripePriceForPlan, getStripeClient } from "../services/stripe";

const requestCreateSchema = z.object({
  service_id: z.string().min(1),
  zone_id: z.string().min(1),
  title: z.string().min(3),
  description: z.string().min(10),
  desired_date: z.string().nullable().optional(),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  urgency: z.enum(["low", "standard", "high", "urgent"]).default("standard"),
  budget_min_cents: z.number().int().nonnegative().nullable().optional(),
  budget_max_cents: z.number().int().nonnegative().nullable().optional(),
  work_mode: z.enum(["onsite", "remote", "hybrid"]).default("onsite"),
});

const requestPatchSchema = requestCreateSchema.partial().extend({
  status: z.enum(["draft", "published", "in_discussion", "awarded", "expired", "cancelled", "closed"]).optional(),
});

const quoteCreateSchema = z.object({
  request_id: z.string().min(1),
  message: z.string().min(5),
  estimated_price_cents: z.number().int().nonnegative().nullable().optional(),
  proposed_date: z.string().nullable().optional(),
  proposed_time_window: z.string().nullable().optional(),
  delay_days: z.number().int().min(0).nullable().optional(),
});

const quotePatchSchema = quoteCreateSchema.omit({ request_id: true }).partial().extend({
  status: z.enum(["sent", "accepted", "rejected", "withdrawn"]).optional(),
});

const awardSchema = z.object({
  quote_id: z.string().min(1),
});

const reviewCreateSchema = z.object({
  mission_id: z.string().min(1),
  target_provider_profile_id: z.string().min(1).optional().nullable(),
  target_user_id: z.string().min(1).optional().nullable(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3).optional().nullable(),
}).refine((d) => d.target_provider_profile_id || d.target_user_id, {
  message: "target_provider_profile_id or target_user_id is required",
});

const disputeCreateSchema = z.object({
  mission_id: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  against_user_id: z.string().nullable().optional(),
  category: z.string().min(1),
  description: z.string().min(10),
});

const disputeMessageCreateSchema = z.object({
  body: z.string().min(1),
  attachment_url: z.string().url().optional().nullable(),
});

const conversationMessageCreateSchema = z.object({
  body: z.string().min(1),
  message_type: z.enum(["text", "attachment", "system"]).default("text"),
  attachment_url: z.string().url().optional().nullable(),
});

const notificationPreferencesPatchSchema = z.object({
  email_messages_enabled: z.boolean().optional(),
  email_quotes_enabled: z.boolean().optional(),
  email_billing_enabled: z.boolean().optional(),
  email_marketing_enabled: z.boolean().optional(),
  push_enabled: z.boolean().optional(),
});

const cancelSchema = z.object({
  cancellation_reason: z.string().max(100).nullable().optional(),
  cancellation_note: z.string().max(1000).nullable().optional(),
});

const activateSubscriptionSchema = z.object({
  plan_id: z.string().min(1),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

function normalizeBoolean(value: unknown) {
  return value === true || value === 1 || value === "1";
}

async function getRequestsColumnSupport() {
  const [
    hasCategoryId,
    hasBudgetIndicativeCents,
    hasOffersCount,
    hasNewOffersCount,
    hasUnreadMessagesClientCount,
    hasActionRequiredClient,
  ] = await Promise.all([
    hasColumn("requests", "category_id"),
    hasColumn("requests", "budget_indicative_cents"),
    hasColumn("requests", "offers_count"),
    hasColumn("requests", "new_offers_count"),
    hasColumn("requests", "unread_messages_client_count"),
    hasColumn("requests", "action_required_client"),
  ]);

  return {
    hasCategoryId,
    hasBudgetIndicativeCents,
    hasOffersCount,
    hasNewOffersCount,
    hasUnreadMessagesClientCount,
    hasActionRequiredClient,
  };
}

async function getQuotesColumnSupport() {
  const [
    hasEstimatedPriceCents,
    hasDelayDays,
    hasProposedDate,
    hasProposedTimeWindow,
    hasUnreadClient,
    hasUnreadProvider,
  ] = await Promise.all([
    hasColumn("quotes", "estimated_price_cents"),
    hasColumn("quotes", "delay_days"),
    hasColumn("quotes", "proposed_date"),
    hasColumn("quotes", "proposed_time_window"),
    hasColumn("quotes", "unread_messages_client_count"),
    hasColumn("quotes", "unread_messages_provider_count"),
  ]);

  return {
    hasEstimatedPriceCents,
    hasDelayDays,
    hasProposedDate,
    hasProposedTimeWindow,
    hasUnreadClient,
    hasUnreadProvider,
  };
}

async function getPlatformSettings() {
  const [hasAutoExpiryDays, hasPaymentEnabled, hasPaymentPrice] = await Promise.all([
    hasColumn("platform_settings", "request_auto_expiry_days"),
    hasColumn("platform_settings", "request_publication_payment_enabled"),
    hasColumn("platform_settings", "default_request_publication_price_cents"),
  ]);
  const cols = [
    "currency",
    hasAutoExpiryDays ? "request_auto_expiry_days" : null,
    hasPaymentEnabled ? "request_publication_payment_enabled" : null,
    hasPaymentPrice ? "default_request_publication_price_cents" : null,
  ].filter(Boolean).join(", ");
  const settings = await queryOne<{
    currency: string;
    request_auto_expiry_days?: number;
    request_publication_payment_enabled?: number;
    default_request_publication_price_cents?: number;
  }>(`SELECT ${cols} FROM platform_settings WHERE id = 1`);

  return {
    request_auto_expiry_days: Math.max(1, Number(settings?.request_auto_expiry_days ?? 7)),
    currency: settings?.currency ?? "CAD",
    request_publication_payment_enabled: hasPaymentEnabled
      ? Number(settings?.request_publication_payment_enabled ?? 0) === 1
      : false,
    default_request_publication_price_cents: hasPaymentPrice
      ? Number(settings?.default_request_publication_price_cents ?? 0)
      : 0,
  };
}

async function createInAppNotification(connection: PoolConnection | null, userId: string, type: string, title: string, body: string) {
  const sql = `INSERT INTO notifications (id, user_id, type, title, body, channel, is_read, sent_at)
               VALUES (?, ?, ?, ?, ?, 'in_app', 0, NOW())`;
  const params = [createId("notif"), userId, type, title, body];

  if (connection) {
    await connection.execute(sql, params);
  } else {
    await execute(sql, params);
  }

  // Fire-and-forget: send push if user has push enabled
  queryOne<{ push_enabled: number }>(
    "SELECT push_enabled FROM notification_preferences WHERE user_id = ?",
    [userId],
  ).then((prefs) => {
    if (prefs?.push_enabled) {
      return sendPushToUser(userId, { title, body });
    }
  }).catch(() => undefined);
}

function triggerReferralReward(userId: string) {
  completeReferralOnFirstPublish(userId)
    .then(async (result) => {
      if (!result) return;
      await createInAppNotification(
        null,
        result.referrerId,
        "referral_completed",
        "Parrainage accompli !",
        "Votre filleul a publie sa premiere demande sur Jobizy.",
      );
      void sendEventEmail({
        userId: result.referrerId,
        type: "referral_completed",
        title: "Parrainage accompli !",
        body: "Votre filleul a publie sa premiere demande sur Jobizy.",
      });
    })
    .catch(() => undefined);
}

async function ensureActiveService(serviceId: string) {
  const service = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM services WHERE id = ?`, [serviceId]);
  if (!service || service.status !== "active") {
    throw new ApiError(400, "SERVICE_INVALID", "Le service doit etre actif.");
  }
}

async function ensureActiveZone(zoneId: string) {
  const zone = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM zones WHERE id = ?`, [zoneId]);
  if (!zone || zone.status !== "active") {
    throw new ApiError(400, "ZONE_INVALID", "La zone doit etre active.");
  }
}

async function ensureOwnRequest(userId: string, requestId: string) {
  const request = await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
  if (!request) {
    throw new ApiError(404, "REQUEST_NOT_FOUND", "Demande introuvable.");
  }
  if (request.client_user_id !== userId) {
    throw new ApiError(403, "REQUEST_FORBIDDEN", "Acces refuse a cette demande.");
  }
  return request;
}

async function getProviderProfileForUser(userId: string) {
  const profile = await queryOne<any>(`SELECT * FROM provider_profiles WHERE user_id = ?`, [userId]);
  if (!profile) {
    throw new ApiError(403, "PROVIDER_ROLE_NOT_ACTIVE", "Le role prestataire n'est pas actif.");
  }
  if (!["draft", "pending_review", "active"].includes(profile.provider_status)) {
    throw new ApiError(403, "PROVIDER_NOT_ELIGIBLE", "Le prestataire n'est pas eligible.");
  }
  return profile;
}

async function getProviderUserId(providerProfileId: string) {
  const provider = await queryOne<{ user_id: string }>(`SELECT user_id FROM provider_profiles WHERE id = ?`, [providerProfileId]);
  return provider?.user_id ?? null;
}

async function getOrActivateSubscription(connection: PoolConnection | null, userId: string, providerProfileId: string) {
  const hasPlanBadge = await hasColumn("plans", "badge");
  const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
  const readSql = `
    SELECT s.*, p.code AS plan_code, p.name AS plan_name,
           ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
           ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
           p.response_limit, p.priority_level
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
     WHERE s.provider_profile_id = ?
       AND s.status = 'active'
     ORDER BY p.priority_level DESC, s.updated_at DESC
     LIMIT 1
  `;

  const existing = connection
    ? ((await connection.query(readSql, [providerProfileId]))[0] as any[])[0] ?? null
    : await queryOne<any>(readSql, [providerProfileId]);
  if (existing) {
    return existing;
  }

  const freePlan = connection
    ? ((await connection.query(`SELECT * FROM plans WHERE status = 'active' ORDER BY price_cents ASC, priority_level ASC LIMIT 1`))[0] as any[])[0] ?? null
    : await queryOne<any>(`SELECT * FROM plans WHERE status = 'active' ORDER BY price_cents ASC, priority_level ASC LIMIT 1`);
  if (!freePlan) {
    throw new ApiError(500, "PLAN_NOT_CONFIGURED", "Aucun plan actif n'est configure.");
  }

  const params = [createId("sub"), userId, providerProfileId, freePlan.id];
  if (connection) {
    await connection.execute(
      `INSERT INTO subscriptions (id, user_id, provider_profile_id, plan_id, status, starts_at, ends_at)
       VALUES (?, ?, ?, ?, 'active', NOW(), NULL)`,
      params,
    );
  } else {
    await execute(
      `INSERT INTO subscriptions (id, user_id, provider_profile_id, plan_id, status, starts_at, ends_at)
       VALUES (?, ?, ?, ?, 'active', NOW(), NULL)`,
      params,
    );
  }

  return connection
    ? ((await connection.query(readSql, [providerProfileId]))[0] as any[])[0] ?? null
    : await queryOne<any>(readSql, [providerProfileId]);
}

async function ensureProviderCanRespond(userId: string) {
  const profile = await getProviderProfileForUser(userId);
  if (profile.provider_status !== "active") {
    throw new ApiError(403, "PROVIDER_NOT_ACTIVE", "Le profil prestataire doit etre actif pour repondre.");
  }
  if (!profile.display_name?.trim() || !profile.business_name?.trim() || !profile.description?.trim()) {
    throw new ApiError(403, "PROVIDER_PROFILE_INCOMPLETE", "Le profil prestataire doit etre complete.");
  }

  const [services, zones, availabilities] = await Promise.all([
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM provider_services WHERE provider_profile_id = ? AND status = 'active'`, [profile.id]),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM provider_zones WHERE provider_profile_id = ?`, [profile.id]),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM availabilities WHERE provider_profile_id = ? AND is_active = 1`, [profile.id]),
  ]);

  if ((services?.total ?? 0) === 0 || (zones?.total ?? 0) === 0 || (availabilities?.total ?? 0) === 0) {
    throw new ApiError(403, "PROVIDER_PROFILE_INCOMPLETE", "Services, zones et disponibilites sont requis.");
  }

  const subscription = await getOrActivateSubscription(null, userId, profile.id);
  return { profile, subscription };
}

async function runMatchingForRequest(connection: PoolConnection, requestRow: any) {
  const [providers] = await connection.query<any[]>(
    `SELECT DISTINCT pp.id, pp.user_id, COALESCE(pl.priority_level, 0) AS priority_level
       FROM provider_profiles pp
       JOIN provider_services ps ON ps.provider_profile_id = pp.id AND ps.service_id = ? AND ps.status = 'active'
       JOIN provider_zones pz ON pz.provider_profile_id = pp.id AND pz.zone_id = ?
       LEFT JOIN subscriptions s ON s.provider_profile_id = pp.id AND s.status = 'active'
       LEFT JOIN plans pl ON pl.id = s.plan_id
      WHERE pp.provider_status = 'active'
        AND pp.user_id != ?`,
    [requestRow.service_id, requestRow.zone_id, requestRow.client_user_id],
  );

  let matchesCreated = 0;
  for (const provider of providers as any[]) {
    const [existingRows] = await connection.query<any[]>(`SELECT id FROM matches WHERE request_id = ? AND provider_profile_id = ?`, [requestRow.id, provider.id]);
    if ((existingRows as any[]).length > 0) continue;

    await connection.execute(
      `INSERT INTO matches (
        id, request_id, provider_profile_id, match_score, match_reason,
        is_visible_to_provider, notified_at, responded_at
      ) VALUES (?, ?, ?, ?, ?, 1, NOW(), NULL)`,
      [
        createId("match"),
        requestRow.id,
        provider.id,
        80 + Number(provider.priority_level ?? 0) * 5,
        JSON.stringify({ reason: "service_zone_match", service_id: requestRow.service_id, zone_id: requestRow.zone_id }),
      ],
    );

    await createInAppNotification(connection, provider.user_id, "request_matched", "Nouvelle opportunite disponible", requestRow.title);
    void sendEventEmail({ userId: provider.user_id, type: "new_match", title: "Nouvelle opportunite disponible", body: requestRow.title });
    matchesCreated += 1;
  }

  return matchesCreated;
}

async function getOrCreateConversation(
  connection: PoolConnection,
  params: { requestId: string | null; missionId: string | null; clientUserId: string; providerProfileId: string },
) {
  const [rows] = await connection.query<any[]>(
    `SELECT *
       FROM conversations
      WHERE client_user_id = ?
        AND provider_profile_id = ?
        AND ((request_id IS NULL AND ? IS NULL) OR request_id = ?)
      LIMIT 1`,
    [params.clientUserId, params.providerProfileId, params.requestId, params.requestId],
  );
  const existing = (rows as any[])[0];
  if (existing) {
    if (params.missionId && !existing.mission_id) {
      await connection.execute(`UPDATE conversations SET mission_id = ?, updated_at = NOW() WHERE id = ?`, [params.missionId, existing.id]);
      existing.mission_id = params.missionId;
    }
    return existing;
  }

  const conversationId = createId("conv");
  await connection.execute(
    `INSERT INTO conversations (id, request_id, mission_id, client_user_id, provider_profile_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [conversationId, params.requestId, params.missionId, params.clientUserId, params.providerProfileId],
  );
  const [createdRows] = await connection.query<any[]>(`SELECT * FROM conversations WHERE id = ?`, [conversationId]);
  return (createdRows as any[])[0];
}

async function ensureConversationAccess(userId: string, conversationId: string) {
  const conversation = await queryOne<any>(
    `SELECT c.*, pp.user_id AS provider_user_id
       FROM conversations c
       JOIN provider_profiles pp ON pp.id = c.provider_profile_id
      WHERE c.id = ?`,
    [conversationId],
  );
  if (!conversation) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation introuvable.");
  }
  if (conversation.client_user_id !== userId && conversation.provider_user_id !== userId) {
    throw new ApiError(403, "CONVERSATION_FORBIDDEN", "Acces refuse a cette conversation.");
  }
  return conversation;
}

async function ensureDisputeAccess(userId: string, disputeId: string) {
  const dispute = await queryOne<any>(`SELECT * FROM disputes WHERE id = ?`, [disputeId]);
  if (!dispute) {
    throw new ApiError(404, "DISPUTE_NOT_FOUND", "Litige introuvable.");
  }
  if (dispute.opened_by_user_id !== userId && dispute.against_user_id !== userId) {
    throw new ApiError(403, "DISPUTE_FORBIDDEN", "Acces refuse a ce litige.");
  }
  return dispute;
}

async function refreshProviderRating(providerProfileId: string) {
  const aggregate = await queryOne<{ average_rating: number | null; total_reviews: number }>(
    `SELECT AVG(rating) AS average_rating, COUNT(*) AS total_reviews
       FROM reviews
      WHERE target_provider_profile_id = ?
        AND status = 'published'`,
    [providerProfileId],
  );

  await execute(
    `UPDATE provider_profiles SET rating_avg = ?, rating_count = ? WHERE id = ?`,
    [Number(aggregate?.average_rating ?? 0), Number(aggregate?.total_reviews ?? 0), providerProfileId],
  );
}

function mapRequestRow(row: any) {
  return {
    ...row,
    action_required_client: normalizeBoolean(row.action_required_client),
  };
}

export function requestsRouter() {
  const router = Router();
  router.use(authRequired);

  router.get(
    "/requests",
    asyncHandler(async (req, res) => {
      const rows = await query<any>(
        `SELECT r.*, s.name AS service_name, z.name AS zone_name
           FROM requests r
           JOIN services s ON s.id = r.service_id
           JOIN zones z ON z.id = r.zone_id
          WHERE r.client_user_id = ?
          ORDER BY r.updated_at DESC`,
        [req.user!.id],
      );
      return ok(res, rows.map(mapRequestRow));
    }),
  );

  router.post(
    "/requests",
    asyncHandler(async (req, res) => {
      const payload = requestCreateSchema.parse(req.body);
      await ensureActiveService(payload.service_id);
      await ensureActiveZone(payload.zone_id);

      const requestId = createId("req");
      const budgetIndicative =
        payload.budget_min_cents != null && payload.budget_max_cents != null
          ? Math.round((payload.budget_min_cents + payload.budget_max_cents) / 2)
          : payload.budget_max_cents ?? payload.budget_min_cents ?? null;
      const requestColumns = await getRequestsColumnSupport();

      const columns = [
        "id",
        "client_user_id",
        ...(requestColumns.hasCategoryId ? ["category_id"] : []),
        "service_id",
        "zone_id",
        "title",
        "description",
        "desired_date",
        "time_window_start",
        "time_window_end",
        "urgency",
        "budget_min_cents",
        "budget_max_cents",
        ...(requestColumns.hasBudgetIndicativeCents ? ["budget_indicative_cents"] : []),
        "work_mode",
        "status",
        ...(requestColumns.hasOffersCount ? ["offers_count"] : []),
        ...(requestColumns.hasNewOffersCount ? ["new_offers_count"] : []),
        ...(requestColumns.hasUnreadMessagesClientCount ? ["unread_messages_client_count"] : []),
        ...(requestColumns.hasActionRequiredClient ? ["action_required_client"] : []),
      ];

      const values = [
        requestId,
        req.user!.id,
        ...(requestColumns.hasCategoryId ? [null] : []),
        payload.service_id,
        payload.zone_id,
        payload.title,
        payload.description,
        payload.desired_date ?? null,
        payload.time_window_start ?? null,
        payload.time_window_end ?? null,
        payload.urgency,
        payload.budget_min_cents ?? null,
        payload.budget_max_cents ?? null,
        ...(requestColumns.hasBudgetIndicativeCents ? [budgetIndicative] : []),
        payload.work_mode,
        "draft",
        ...(requestColumns.hasOffersCount ? [0] : []),
        ...(requestColumns.hasNewOffersCount ? [0] : []),
        ...(requestColumns.hasUnreadMessagesClientCount ? [0] : []),
        ...(requestColumns.hasActionRequiredClient ? [0] : []),
      ];

      const result = await withTransaction(async (connection) => {
        await connection.execute(
          `INSERT INTO requests (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          values,
        );

        const settings = await getPlatformSettings();
        const paymentRequired =
          settings.request_publication_payment_enabled &&
          settings.default_request_publication_price_cents > 0;

        if (!paymentRequired) {
          const publishAssignments = [
            `status = 'published'`,
            `published_at = NOW()`,
            `expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)`,
            ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 0`] : []),
            `updated_at = NOW()`,
          ];
          await connection.execute(
            `UPDATE requests SET ${publishAssignments.join(", ")} WHERE id = ?`,
            [settings.request_auto_expiry_days, requestId],
          );
          const [rows] = await connection.query<any[]>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
          const publishedRequest = (rows as any[])[0];
          await runMatchingForRequest(connection, publishedRequest.id, publishedRequest.service_id, publishedRequest.zone_id, publishedRequest.title);
          await createInAppNotification(connection, req.user!.id, "request_published", "Demande publiee", publishedRequest.title);
          return mapRequestRow(publishedRequest);
        }

        const [draftRows] = await connection.query<any[]>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
        const draftRequest = (draftRows as any[])[0];
        return mapRequestRow(draftRequest);
      });

      if (result.status === "published") {
        void sendEventEmail({ userId: req.user!.id, type: "request_published", title: "Demande publiee", body: result.title });
        triggerReferralReward(req.user!.id);
      }
      return created(res, result);
    }),
  );

  router.get(
    "/requests/:id",
    asyncHandler(async (req, res) => ok(res, mapRequestRow(await ensureOwnRequest(req.user!.id, String(req.params.id))))),
  );

  router.patch(
    "/requests/:id",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      if (!["draft", "published"].includes(requestRow.status)) {
        throw new ApiError(400, "REQUEST_NOT_EDITABLE", "Seules les demandes en brouillon ou publiées peuvent etre modifiees.");
      }
      const payload = requestPatchSchema.parse(req.body);
      if (payload.service_id) await ensureActiveService(payload.service_id);
      if (payload.zone_id) await ensureActiveZone(payload.zone_id);

      const updatePayload: Record<string, unknown> = {
        ...(payload.service_id !== undefined ? { service_id: payload.service_id } : {}),
        ...(payload.zone_id !== undefined ? { zone_id: payload.zone_id } : {}),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.desired_date !== undefined ? { desired_date: payload.desired_date } : {}),
        ...(payload.time_window_start !== undefined ? { time_window_start: payload.time_window_start } : {}),
        ...(payload.time_window_end !== undefined ? { time_window_end: payload.time_window_end } : {}),
        ...(payload.urgency !== undefined ? { urgency: payload.urgency } : {}),
        ...(payload.budget_min_cents !== undefined ? { budget_min_cents: payload.budget_min_cents } : {}),
        ...(payload.budget_max_cents !== undefined ? { budget_max_cents: payload.budget_max_cents } : {}),
        ...(payload.work_mode !== undefined ? { work_mode: payload.work_mode } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      };

      if (payload.budget_min_cents !== undefined || payload.budget_max_cents !== undefined) {
        const nextMin = payload.budget_min_cents ?? requestRow.budget_min_cents ?? null;
        const nextMax = payload.budget_max_cents ?? requestRow.budget_max_cents ?? null;
        if (await hasColumn("requests", "budget_indicative_cents")) {
          updatePayload.budget_indicative_cents =
            nextMin != null && nextMax != null ? Math.round((Number(nextMin) + Number(nextMax)) / 2) : nextMax ?? nextMin ?? null;
        }
      }

      const entries = Object.entries(updatePayload);
      if (entries.length > 0) {
        await execute(
          `UPDATE requests SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...entries.map(([, value]) => value), requestRow.id],
        );
      }

      return ok(res, mapRequestRow(await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [requestRow.id])));
    }),
  );

  router.delete(
    "/requests/:id",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      if (requestRow.status !== "draft") {
        throw new ApiError(400, "REQUEST_NOT_DELETABLE", "Seules les demandes en brouillon peuvent etre supprimees.");
      }
      await execute(`DELETE FROM requests WHERE id = ?`, [requestRow.id]);
      return ok(res, { deleted: true });
    }),
  );

  router.post(
    "/requests/:id/publication-preview",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      const settings = await getPlatformSettings();
      const paymentRequired =
        settings.request_publication_payment_enabled &&
        settings.default_request_publication_price_cents > 0;
      const priceCents = paymentRequired ? settings.default_request_publication_price_cents : 0;
      return ok(res, {
        request_id: requestRow.id,
        publication_payment_required: paymentRequired,
        publication_price_cents: priceCents,
        publication_tax_cents: 0,
        publication_total_cents: priceCents,
        currency: settings.currency,
        model: paymentRequired ? "external-payment" : "free",
      });
    }),
  );

  router.post(
    "/requests/:id/publication-checkout",
    authRequired,
    asyncHandler(async (req, res) => {
      const requestId = String(req.params.id);
      const requestRow = await ensureOwnRequest(req.user!.id, requestId);

      if (!["draft", "cancelled", "expired"].includes(requestRow.status)) {
        throw new ApiError(400, "REQUEST_NOT_PUBLISHABLE", "Cette demande ne peut pas etre publiee.");
      }

      const settings = await getPlatformSettings();
      if (!settings.request_publication_payment_enabled || settings.default_request_publication_price_cents <= 0) {
        throw new ApiError(400, "PUBLICATION_FREE", "La publication de cette demande est gratuite.");
      }

      const priceCents = settings.default_request_publication_price_cents;
      const stripe = getStripeClient();

      const body = req.body as { success_url?: string; cancel_url?: string };
      const frontendUrl = (process.env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, "");
      const successUrl = (body.success_url ?? `${frontendUrl}/fr-CA/app/demandes?publication_payment=success&request_id=${requestId}`);
      const cancelUrl = (body.cancel_url ?? `${frontendUrl}/fr-CA/app/demandes?publication_payment=cancelled`);

      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: req.user!.email,
        line_items: [
          {
            price_data: {
              currency: settings.currency.toLowerCase(),
              unit_amount: priceCents,
              product_data: {
                name: "Publication de demande",
                description: requestRow.title,
              },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          local_request_id: requestId,
          user_id: req.user!.id,
        },
      });

      const paymentId = createId("pay");
      await execute(
        `INSERT INTO payments (id, user_id, payment_type, related_entity_type, related_entity_id,
          amount_cents, tax_amount_cents, total_amount_cents, currency, provider,
          provider_checkout_session_id, status)
         VALUES (?, ?, 'request_publication', 'request', ?, ?, 0, ?, ?, 'stripe', ?, 'pending')`,
        [paymentId, req.user!.id, requestId, priceCents, priceCents, settings.currency, checkoutSession.id],
      );

      return ok(res, { checkout_url: checkoutSession.url });
    }),
  );

  // Vérifie directement auprès de Stripe si le paiement a été confirmé, sans
  // attendre le webhook. Appelé par le frontend après retour de la page de paiement.
  router.post(
    "/requests/:id/confirm-publication-payment",
    authRequired,
    asyncHandler(async (req, res) => {
      const requestId = String(req.params.id);
      const requestRow = await ensureOwnRequest(req.user!.id, requestId);

      if (requestRow.status === "published") {
        return ok(res, { status: "published", already_published: true });
      }

      const payment = await queryOne<{
        id: string;
        status: string;
        provider_checkout_session_id: string | null;
        provider_payment_intent_id: string | null;
      }>(
        `SELECT id, status, provider_checkout_session_id, provider_payment_intent_id
           FROM payments
          WHERE related_entity_type = 'request'
            AND related_entity_id = ?
            AND payment_type = 'request_publication'
          ORDER BY created_at DESC
          LIMIT 1`,
        [requestId],
      );

      if (!payment) {
        throw new ApiError(404, "PAYMENT_NOT_FOUND", "Aucun paiement trouve pour cette demande.");
      }

      if (payment.status !== "paid") {
        // Interroge Stripe directement pour savoir si le checkout est passé
        const stripe = getStripeClient();
        const sessionId = payment.provider_checkout_session_id;
        if (!sessionId) {
          throw new ApiError(402, "PUBLICATION_PAYMENT_REQUIRED", "Paiement non confirme.");
        }

        const stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
        if (stripeSession.payment_status !== "paid") {
          throw new ApiError(402, "PUBLICATION_PAYMENT_REQUIRED", "Paiement non encore confirme par Stripe.");
        }

        // Le paiement est confirmé par Stripe → on met à jour localement
        const paymentIntentId =
          typeof stripeSession.payment_intent === "string"
            ? stripeSession.payment_intent
            : (stripeSession.payment_intent as { id: string } | null)?.id ?? null;

        await execute(
          `UPDATE payments
              SET status = 'paid',
                  paid_at = COALESCE(paid_at, NOW()),
                  provider_payment_intent_id = COALESCE(provider_payment_intent_id, ?),
                  updated_at = NOW()
            WHERE id = ?`,
          [paymentIntentId, payment.id],
        );
      }

      // Paiement confirmé — on publie la demande
      const settings = await getPlatformSettings();
      const requestColumns = await getRequestsColumnSupport();
      const result = await withTransaction(async (connection) => {
        if (!["draft", "cancelled", "expired"].includes(requestRow.status)) {
          return { request: requestRow, matches_created: 0 };
        }
        const publishAssignments = [
          `status = 'published'`,
          `published_at = NOW()`,
          `expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)`,
          ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 0`] : []),
          `updated_at = NOW()`,
        ];
        await connection.execute(
          `UPDATE requests SET ${publishAssignments.join(", ")} WHERE id = ?`,
          [settings.request_auto_expiry_days, requestId],
        );
        const [rows] = await connection.query<any[]>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
        const publishedRequest = (rows as any[])[0];
        const matchesCreated = await runMatchingForRequest(
          connection,
          publishedRequest.id,
          publishedRequest.service_id,
          publishedRequest.zone_id,
          publishedRequest.title,
        );
        await createInAppNotification(connection, req.user!.id, "request_published", "Demande publiee", publishedRequest.title);
        return { request: publishedRequest, matches_created: matchesCreated };
      });

      void sendEventEmail({ userId: req.user!.id, type: "request_published", title: "Demande publiee", body: result.request.title });
      triggerReferralReward(req.user!.id);
      return ok(res, { ...result, request: mapRequestRow(result.request), already_published: false });
    }),
  );

  router.post(
    "/requests/:id/publish",
    asyncHandler(async (req, res) => {
      const requestId = String(req.params.id);
      const requestRow = await ensureOwnRequest(req.user!.id, requestId);
      if (!["draft", "cancelled", "expired"].includes(requestRow.status)) {
        throw new ApiError(400, "REQUEST_NOT_PUBLISHABLE", "Cette demande ne peut pas etre publiee.");
      }

      const settings = await getPlatformSettings();
      if (settings.request_publication_payment_enabled && settings.default_request_publication_price_cents > 0) {
        const confirmedPayment = await queryOne<{ id: string }>(
          `SELECT id FROM payments WHERE related_entity_type = 'request' AND related_entity_id = ? AND payment_type = 'request_publication' AND status = 'paid' LIMIT 1`,
          [requestId],
        );
        if (!confirmedPayment) {
          throw new ApiError(402, "PUBLICATION_PAYMENT_REQUIRED", "La publication de cette demande nécessite un paiement préalable.");
        }
      }

      const result = await withTransaction(async (connection) => {
        const settings = await getPlatformSettings();
        const requestColumns = await getRequestsColumnSupport();
        const publishAssignments = [
          `status = 'published'`,
          `published_at = NOW()`,
          `expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)`,
          ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 0`] : []),
          `updated_at = NOW()`,
        ];
        await connection.execute(
          `UPDATE requests SET ${publishAssignments.join(", ")} WHERE id = ?`,
          [settings.request_auto_expiry_days, requestId],
        );
        const [rows] = await connection.query<any[]>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
        const publishedRequest = (rows as any[])[0];
        const matchesCreated = await runMatchingForRequest(
          connection,
          publishedRequest.id,
          publishedRequest.service_id,
          publishedRequest.zone_id,
          publishedRequest.title,
        );
        await createInAppNotification(connection, req.user!.id, "request_published", "Demande publiee", publishedRequest.title);
        return { request: publishedRequest, matches_created: matchesCreated, already_published: false };
      });

      if (!result.already_published) {
        void sendEventEmail({ userId: req.user!.id, type: "request_published", title: "Demande publiee", body: result.request.title });
        triggerReferralReward(req.user!.id);
      }
      return ok(res, { ...result, request: mapRequestRow(result.request) });
    }),
  );

  router.post(
    "/requests/:id/close",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      const requestColumns = await getRequestsColumnSupport();
      const closeAssignments = [
        `status = 'closed'`,
        ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 0`] : []),
        `updated_at = NOW()`,
      ];
      await execute(`UPDATE requests SET ${closeAssignments.join(", ")} WHERE id = ?`, [requestRow.id]);
      return ok(res, mapRequestRow(await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [requestRow.id])));
    }),
  );

  router.post(
    "/requests/:id/cancel",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      if (!["published", "in_discussion"].includes(requestRow.status)) {
        throw new ApiError(400, "REQUEST_NOT_CANCELLABLE", "Seules les demandes publiees peuvent etre annulees.");
      }
      const payload = cancelSchema.parse(req.body);
      const notifyProviderIds: string[] = [];

      await withTransaction(async (connection) => {
        const [requestColumns, hasCancelAt, hasCancelBy, hasCancelReason, hasCancelNote] = await Promise.all([
          getRequestsColumnSupport(),
          hasColumn("requests", "cancelled_at"),
          hasColumn("requests", "cancelled_by_user_id"),
          hasColumn("requests", "cancellation_reason"),
          hasColumn("requests", "cancellation_note"),
        ]);

        const assignments: string[] = [`status = 'cancelled'`];
        const params: unknown[] = [];
        if (requestColumns.hasActionRequiredClient) assignments.push(`action_required_client = 0`);
        if (hasCancelAt) assignments.push(`cancelled_at = NOW()`);
        if (hasCancelBy) { assignments.push(`cancelled_by_user_id = ?`); params.push(req.user!.id); }
        if (hasCancelReason) { assignments.push(`cancellation_reason = ?`); params.push(payload.cancellation_reason ?? null); }
        if (hasCancelNote) { assignments.push(`cancellation_note = ?`); params.push(payload.cancellation_note ?? null); }
        assignments.push(`updated_at = NOW()`);

        await connection.execute(`UPDATE requests SET ${assignments.join(", ")} WHERE id = ?`, [...params, requestRow.id]);
        await connection.execute(`UPDATE matches SET is_visible_to_provider = 0 WHERE request_id = ?`, [requestRow.id]);

        // Notifier les prestataires ayant une offre active (status = 'sent')
        const [quoteRows] = await connection.query<any[]>(
          `SELECT pp.user_id AS provider_user_id
             FROM quotes q
             JOIN provider_profiles pp ON pp.id = q.provider_profile_id
            WHERE q.request_id = ? AND q.status = 'sent'`,
          [requestRow.id],
        );
        for (const row of quoteRows as any[]) {
          await createInAppNotification(connection, row.provider_user_id, "request_cancelled", "Demande annulee", requestRow.title);
          notifyProviderIds.push(row.provider_user_id);
        }

        await writeAuditLog(
          connection,
          req.user!.id,
          "request",
          requestRow.id,
          "cancelled",
          { cancellation_reason: payload.cancellation_reason ?? null, cancellation_note: payload.cancellation_note ?? null },
          req.ip ?? null,
        );
      });

      // Emails envoyés hors transaction
      for (const providerId of notifyProviderIds) {
        void sendEventEmail({
          userId: providerId,
          type: "request_cancelled",
          title: "Demande annulee",
          body: `La demande "${requestRow.title}" a ete annulee par le client. Votre offre a ete automatiquement archivee.`,
        });
      }

      return ok(res, mapRequestRow(await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [requestRow.id])));
    }),
  );

  router.get(
    "/matches",
    asyncHandler(async (req, res) => {
      const provider = await ensureProviderCanRespond(req.user!.id);
      const hasBudgetIndicativeCents = await hasColumn("requests", "budget_indicative_cents");
      const rows = await query<any>(
        `SELECT m.*, r.title, r.description, r.desired_date, r.urgency, r.status, r.zone_id,
                ${hasBudgetIndicativeCents ? "r.budget_indicative_cents" : "COALESCE(r.budget_max_cents, r.budget_min_cents) AS budget_indicative_cents"}, z.name AS zone_name, s.name AS service_name
           FROM matches m
           JOIN requests r ON r.id = m.request_id
           JOIN zones z ON z.id = r.zone_id
           JOIN services s ON s.id = r.service_id
          WHERE m.provider_profile_id = ?
            AND m.is_visible_to_provider = 1
            AND r.status IN ('published', 'in_discussion')
            AND r.client_user_id != ?
          ORDER BY m.match_score DESC, r.updated_at DESC`,
        [provider.profile.id, req.user!.id],
      );
      return ok(res, rows.map((row) => ({ ...row, is_visible_to_provider: normalizeBoolean(row.is_visible_to_provider) })));
    }),
  );

  router.get(
    "/quotes",
    asyncHandler(async (req, res) => {
      const requestId = typeof req.query.request_id === "string" ? req.query.request_id : null;
      if (!requestId) return ok(res, []);

      const ownedRequest = await queryOne<any>(`SELECT id FROM requests WHERE id = ? AND client_user_id = ?`, [requestId, req.user!.id]);
      const providerProfile = ownedRequest ? null : await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      const rows = await query<any>(
        `SELECT q.*, pp.display_name, pp.business_name, pp.rating_avg, pp.rating_count,
                c.id AS conversation_id
           FROM quotes q
           JOIN provider_profiles pp ON pp.id = q.provider_profile_id
           LEFT JOIN conversations c ON c.request_id = q.request_id AND c.provider_profile_id = q.provider_profile_id
          WHERE q.request_id = ?` + (ownedRequest ? "" : providerProfile ? " AND q.provider_profile_id = ?" : " AND 1 = 0") + ` ORDER BY q.updated_at DESC`,
        ownedRequest ? [requestId] : providerProfile ? [requestId, providerProfile.id] : [requestId],
      );
      return ok(res, rows);
    }),
  );

  router.get(
    "/provider/quotes",
    asyncHandler(async (req, res) => {
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!providerProfile) return ok(res, []);
      const rows = await query<any>(
        `SELECT q.*, r.title AS request_title, r.status AS request_status,
                c.id AS conversation_id
           FROM quotes q
           JOIN requests r ON r.id = q.request_id
           LEFT JOIN conversations c ON c.request_id = q.request_id AND c.provider_profile_id = q.provider_profile_id
          WHERE q.provider_profile_id = ?
          ORDER BY q.updated_at DESC`,
        [providerProfile.id],
      );
      return ok(res, rows);
    }),
  );

  router.post(
    "/quotes",
    asyncHandler(async (req, res) => {
      const payload = quoteCreateSchema.parse(req.body);
      const requestRow = await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [payload.request_id]);
      if (!requestRow) {
        throw new ApiError(404, "REQUEST_NOT_FOUND", "Demande introuvable.");
      }
      if (!["published", "in_discussion"].includes(requestRow.status)) {
        throw new ApiError(400, "REQUEST_NOT_OPEN", "Cette demande n'accepte plus d'offres.");
      }

      const { profile } = await ensureProviderCanRespond(req.user!.id);
      const existingQuote = await queryOne<any>(`SELECT id FROM quotes WHERE request_id = ? AND provider_profile_id = ?`, [requestRow.id, profile.id]);
      if (existingQuote) {
        throw new ApiError(409, "QUOTE_ALREADY_EXISTS", "Une offre existe deja pour cette demande.");
      }

      const quote = await withTransaction(async (connection) => {
        const quoteId = createId("quote");
        const [requestColumns, quoteCols] = await Promise.all([
          getRequestsColumnSupport(),
          getQuotesColumnSupport(),
        ]);

        const quoteFields = ["id", "request_id", "provider_profile_id", "message", "status"];
        const quoteValues: unknown[] = [quoteId, requestRow.id, profile.id, payload.message, "sent"];

        if (quoteCols.hasEstimatedPriceCents) {
          quoteFields.push("estimated_price_cents");
          quoteValues.push(payload.estimated_price_cents ?? null);
        }
        if (quoteCols.hasDelayDays) {
          quoteFields.push("delay_days");
          quoteValues.push(payload.delay_days ?? null);
        }
        if (quoteCols.hasProposedDate) {
          quoteFields.push("proposed_date");
          quoteValues.push(payload.proposed_date ?? null);
        }
        if (quoteCols.hasProposedTimeWindow) {
          quoteFields.push("proposed_time_window");
          quoteValues.push(payload.proposed_time_window ?? null);
        }
        if (quoteCols.hasUnreadClient) {
          quoteFields.push("unread_messages_client_count");
          quoteValues.push(0);
        }
        if (quoteCols.hasUnreadProvider) {
          quoteFields.push("unread_messages_provider_count");
          quoteValues.push(0);
        }

        await connection.execute(
          `INSERT INTO quotes (${quoteFields.join(", ")}) VALUES (${quoteFields.map(() => "?").join(", ")})`,
          quoteValues,
        );

        const requestAssignments = [
          ...(requestColumns.hasOffersCount ? [`offers_count = offers_count + 1`] : []),
          ...(requestColumns.hasNewOffersCount ? [`new_offers_count = new_offers_count + 1`] : []),
          ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 1`] : []),
          `status = CASE WHEN status = 'published' THEN 'in_discussion' ELSE status END`,
          `updated_at = NOW()`,
        ];
        await connection.execute(
          `UPDATE requests SET ${requestAssignments.join(", ")} WHERE id = ?`,
          [requestRow.id],
        );

        const conversation = await getOrCreateConversation(connection, {
          requestId: requestRow.id,
          missionId: null,
          clientUserId: requestRow.client_user_id,
          providerProfileId: profile.id,
        });

        await connection.execute(
          `INSERT INTO messages (id, conversation_id, sender_user_id, message_type, body, attachment_url)
           VALUES (?, ?, ?, 'system', ?, NULL)`,
          [createId("msg"), conversation.id, req.user!.id, "Offre envoyee"],
        );

        await createInAppNotification(connection, requestRow.client_user_id, "quote_received", "Nouvelle offre recue", requestRow.title);
        void sendEventEmail({ userId: requestRow.client_user_id, type: "quote_received", title: "Nouvelle offre recue", body: requestRow.title });

        const [rows] = await connection.query<any[]>(
          `SELECT q.*, pp.display_name, pp.business_name, pp.rating_avg, pp.rating_count
             FROM quotes q
             JOIN provider_profiles pp ON pp.id = q.provider_profile_id
            WHERE q.id = ?`,
          [quoteId],
        );
        return (rows as any[])[0];
      });

      return created(res, quote);
    }),
  );

  router.patch(
    "/quotes/:id",
    asyncHandler(async (req, res) => {
      const profile = await getProviderProfileForUser(req.user!.id);
      const quote = await queryOne<any>(`SELECT * FROM quotes WHERE id = ? AND provider_profile_id = ?`, [String(req.params.id), profile.id]);
      if (!quote) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "Offre introuvable.");
      }
      if (!["sent", "withdrawn"].includes(quote.status)) {
        throw new ApiError(400, "QUOTE_NOT_EDITABLE", "Cette offre n'est plus modifiable.");
      }

      const payload = quotePatchSchema.parse(req.body);
      const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
      if (entries.length > 0) {
        await execute(
          `UPDATE quotes SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...entries.map(([, value]) => value), quote.id],
        );
      }

      return ok(res, await queryOne<any>(`SELECT * FROM quotes WHERE id = ?`, [quote.id]));
    }),
  );

  router.post(
    "/quotes/:id/withdraw",
    asyncHandler(async (req, res) => {
      const profile = await getProviderProfileForUser(req.user!.id);
      const quote = await queryOne<any>(`SELECT * FROM quotes WHERE id = ? AND provider_profile_id = ?`, [String(req.params.id), profile.id]);
      if (!quote) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "Offre introuvable.");
      }
      if (quote.status !== "sent") {
        throw new ApiError(409, "QUOTE_NOT_WITHDRAWABLE", "Seules les offres en attente peuvent etre retirees.");
      }

      const payload = cancelSchema.parse(req.body);
      const request = await queryOne<any>(`SELECT id, title, client_user_id, status FROM requests WHERE id = ?`, [quote.request_id]);

      await withTransaction(async (connection) => {
        const [hasWithdrawnAt, hasWithdrawnBy, hasCancelReason, hasCancelNote] = await Promise.all([
          hasColumn("quotes", "withdrawn_at"),
          hasColumn("quotes", "withdrawn_by_user_id"),
          hasColumn("quotes", "cancellation_reason"),
          hasColumn("quotes", "cancellation_note"),
        ]);

        const assignments: string[] = [`status = 'withdrawn'`];
        const params: unknown[] = [];
        if (hasWithdrawnAt)  assignments.push(`withdrawn_at = NOW()`);
        if (hasWithdrawnBy)  { assignments.push(`withdrawn_by_user_id = ?`); params.push(req.user!.id); }
        if (hasCancelReason) { assignments.push(`cancellation_reason = ?`); params.push(payload.cancellation_reason ?? null); }
        if (hasCancelNote)   { assignments.push(`cancellation_note = ?`); params.push(payload.cancellation_note ?? null); }
        assignments.push(`updated_at = NOW()`);

        await connection.execute(`UPDATE quotes SET ${assignments.join(", ")} WHERE id = ?`, [...params, quote.id]);

        // Si c'était la dernière offre active sur une demande in_discussion, revenir à published
        if (request?.status === "in_discussion") {
          const [rows] = await connection.query<any[]>(
            `SELECT COUNT(*) AS cnt FROM quotes WHERE request_id = ? AND status = 'sent' AND id <> ?`,
            [request.id, quote.id],
          );
          if ((rows[0] as any).cnt === 0) {
            await connection.execute(`UPDATE requests SET status = 'published', updated_at = NOW() WHERE id = ?`, [request.id]);
          }
        }

        // Notifier le client in-app
        if (request?.client_user_id) {
          await createInAppNotification(connection, request.client_user_id, "quote_withdrawn", "Offre retiree", request.title);
        }

        await writeAuditLog(
          connection,
          req.user!.id,
          "quote",
          quote.id,
          "withdrawn",
          { cancellation_reason: payload.cancellation_reason ?? null, cancellation_note: payload.cancellation_note ?? null },
          req.ip ?? null,
        );
      });

      // Email au client (hors transaction)
      if (request?.client_user_id) {
        void sendEventEmail({
          userId: request.client_user_id,
          type: "quote_withdrawn",
          title: "Offre retiree",
          body: `Un prestataire a retire son offre sur votre demande "${request.title}".`,
        });
      }

      return ok(res, await queryOne<any>(`SELECT * FROM quotes WHERE id = ?`, [quote.id]));
    }),
  );

  router.post(
    "/quotes/:id/reject",
    asyncHandler(async (req, res) => {
      const quote = await queryOne<any>(`SELECT * FROM quotes WHERE id = ?`, [String(req.params.id)]);
      if (!quote) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "Offre introuvable.");
      }

      const requestRow = await ensureOwnRequest(req.user!.id, quote.request_id);
      await execute(`UPDATE quotes SET status = 'rejected', updated_at = NOW() WHERE id = ?`, [quote.id]);
      const providerUserId = await getProviderUserId(quote.provider_profile_id);
      if (providerUserId) {
        await createInAppNotification(null, providerUserId, "quote_rejected", "Offre non retenue", requestRow.title);
        void sendEventEmail({ userId: providerUserId, type: "quote_rejected", title: "Offre non retenue", body: requestRow.title });
      }
      return ok(res, await queryOne<any>(`SELECT * FROM quotes WHERE id = ?`, [quote.id]));
    }),
  );

  router.post(
    "/requests/:id/award",
    asyncHandler(async (req, res) => {
      const requestRow = await ensureOwnRequest(req.user!.id, String(req.params.id));
      const payload = awardSchema.parse(req.body);
      const quote = await queryOne<any>(`SELECT * FROM quotes WHERE id = ? AND request_id = ?`, [payload.quote_id, requestRow.id]);
      if (!quote) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "Offre introuvable.");
      }
      if (quote.status === "withdrawn") {
        throw new ApiError(400, "QUOTE_NOT_AWARDABLE", "Cette offre a ete retiree.");
      }

      const mission = await withTransaction(async (connection) => {
        const existing = ((await connection.query<any[]>(`SELECT * FROM missions WHERE request_id = ? LIMIT 1`, [requestRow.id]))[0] as any[])[0];
        if (existing) {
          throw new ApiError(409, "MISSION_ALREADY_EXISTS", "Une mission existe deja pour cette demande.");
        }

        await connection.execute(`UPDATE quotes SET status = 'rejected', updated_at = NOW() WHERE request_id = ? AND id <> ?`, [requestRow.id, quote.id]);
        await connection.execute(`UPDATE quotes SET status = 'accepted', updated_at = NOW() WHERE id = ?`, [quote.id]);
        const requestColumns = await getRequestsColumnSupport();
        const requestAssignments = [
          `status = 'awarded'`,
          ...(requestColumns.hasActionRequiredClient ? [`action_required_client = 0`] : []),
          ...(requestColumns.hasNewOffersCount ? [`new_offers_count = 0`] : []),
          `updated_at = NOW()`,
        ];
        await connection.execute(
          `UPDATE requests SET ${requestAssignments.join(", ")} WHERE id = ?`,
          [requestRow.id],
        );

        const missionId = createId("mission");
        const [hasIndicativePrice, hasUnreadClient, hasUnreadProvider, hasDisputeOpened] = await Promise.all([
          hasColumn("missions", "indicative_price_cents"),
          hasColumn("missions", "unread_messages_client_count"),
          hasColumn("missions", "unread_messages_provider_count"),
          hasColumn("missions", "dispute_opened"),
        ]);
        const missionColumns = [
          "id", "request_id", "quote_id", "client_user_id", "provider_profile_id", "status",
          ...(hasIndicativePrice ? ["indicative_price_cents"] : []),
          ...(hasUnreadClient ? ["unread_messages_client_count"] : []),
          ...(hasUnreadProvider ? ["unread_messages_provider_count"] : []),
          ...(hasDisputeOpened ? ["dispute_opened"] : []),
        ];
        const missionValues = [
          missionId, requestRow.id, quote.id, req.user!.id, quote.provider_profile_id, "confirmee",
          ...(hasIndicativePrice ? [quote.indicative_price_cents ?? quote.estimated_price_cents ?? null] : []),
          ...(hasUnreadClient ? [0] : []),
          ...(hasUnreadProvider ? [0] : []),
          ...(hasDisputeOpened ? [0] : []),
        ];
        await connection.execute(
          `INSERT INTO missions (${missionColumns.join(", ")}) VALUES (${missionColumns.map(() => "?").join(", ")})`,
          missionValues,
        );

        const conversation = await getOrCreateConversation(connection, {
          requestId: requestRow.id,
          missionId,
          clientUserId: req.user!.id,
          providerProfileId: quote.provider_profile_id,
        });
        await connection.execute(`UPDATE conversations SET mission_id = ?, updated_at = NOW() WHERE id = ?`, [missionId, conversation.id]);

        const providerUserId = await getProviderUserId(quote.provider_profile_id);
        if (providerUserId) {
          await createInAppNotification(connection, providerUserId, "mission_confirmed", "Mission confirmee", requestRow.title);
        }

        return ((await connection.query<any[]>(`SELECT * FROM missions WHERE id = ?`, [missionId]))[0] as any[])[0];
      });

      const missionProviderUserId = await getProviderUserId(quote.provider_profile_id);
      if (missionProviderUserId) {
        void sendEventEmail({ userId: missionProviderUserId, type: "mission_confirmed", title: "Mission confirmee", body: requestRow.title });
      }
      return ok(res, mission);
    }),
  );

  router.get(
    "/missions",
    asyncHandler(async (req, res) => {
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      const rows = await query<any>(
        `SELECT m.*, r.title AS request_title, pp.display_name, pp.business_name
           FROM missions m
           JOIN requests r ON r.id = m.request_id
           JOIN provider_profiles pp ON pp.id = m.provider_profile_id
          WHERE m.client_user_id = ?` + (providerProfile ? " OR m.provider_profile_id = ?" : "") + ` ORDER BY m.updated_at DESC`,
        providerProfile ? [req.user!.id, providerProfile.id] : [req.user!.id],
      );
      return ok(res, rows.map((row) => ({ ...row, dispute_opened: normalizeBoolean(row.dispute_opened) })));
    }),
  );

  router.get(
    "/missions/:id",
    asyncHandler(async (req, res) => {
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [String(req.params.id)]);
      if (!mission) {
        throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      }
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (mission.client_user_id !== req.user!.id && mission.provider_profile_id !== providerProfile?.id) {
        throw new ApiError(403, "MISSION_FORBIDDEN", "Acces refuse a cette mission.");
      }
      return ok(res, { ...mission, dispute_opened: normalizeBoolean(mission.dispute_opened) });
    }),
  );

  router.post(
    "/missions/:id/complete",
    asyncHandler(async (req, res) => {
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [String(req.params.id)]);
      if (!mission) {
        throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      }
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (mission.client_user_id !== req.user!.id && mission.provider_profile_id !== providerProfile?.id) {
        throw new ApiError(403, "MISSION_FORBIDDEN", "Acces refuse a cette mission.");
      }
      if (mission.status !== "en_cours") {
        throw new ApiError(409, "MISSION_INVALID_TRANSITION", "La mission doit etre en cours pour etre terminee.");
      }

      await execute(
        `UPDATE missions
            SET status = 'terminee',
                completed_at = NOW(),
                unread_messages_client_count = 0,
                unread_messages_provider_count = 0,
                updated_at = NOW()
          WHERE id = ?`,
        [mission.id],
      );
      await execute(`UPDATE provider_profiles SET completed_missions_count = completed_missions_count + 1 WHERE id = ?`, [mission.provider_profile_id]);
      return ok(res, await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [mission.id]));
    }),
  );

  router.post(
    "/missions/:id/plan",
    asyncHandler(async (req, res) => {
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [String(req.params.id)]);
      if (!mission) {
        throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      }
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (mission.provider_profile_id !== providerProfile?.id) {
        throw new ApiError(403, "MISSION_FORBIDDEN", "Seul le prestataire peut planifier la mission.");
      }
      if (mission.status !== "confirmee") {
        throw new ApiError(409, "MISSION_INVALID_TRANSITION", "La mission doit etre confirmee pour etre planifiee.");
      }

      await execute(`UPDATE missions SET status = 'planifiee', updated_at = NOW() WHERE id = ?`, [mission.id]);
      return ok(res, await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [mission.id]));
    }),
  );

  router.post(
    "/missions/:id/start",
    asyncHandler(async (req, res) => {
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [String(req.params.id)]);
      if (!mission) {
        throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      }
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (mission.provider_profile_id !== providerProfile?.id) {
        throw new ApiError(403, "MISSION_FORBIDDEN", "Seul le prestataire peut demarrer la mission.");
      }
      if (!["confirmee", "planifiee"].includes(mission.status)) {
        throw new ApiError(409, "MISSION_INVALID_TRANSITION", "La mission doit etre confirmee ou planifiee pour demarrer.");
      }

      await execute(`UPDATE missions SET status = 'en_cours', started_at = NOW(), updated_at = NOW() WHERE id = ?`, [mission.id]);
      return ok(res, await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [mission.id]));
    }),
  );

  router.post(
    "/missions/:id/cancel",
    asyncHandler(async (req, res) => {
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [String(req.params.id)]);
      if (!mission) {
        throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      }
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (mission.client_user_id !== req.user!.id && mission.provider_profile_id !== providerProfile?.id) {
        throw new ApiError(403, "MISSION_FORBIDDEN", "Acces refuse a cette mission.");
      }
      if (["terminee", "annulee", "en_litige"].includes(mission.status)) {
        throw new ApiError(409, "MISSION_INVALID_TRANSITION", "Cette mission ne peut plus etre annulee.");
      }

      const payload = cancelSchema.parse(req.body);
      const isClient = mission.client_user_id === req.user!.id;

      const [hasCancelBy, hasCancelReason, hasCancelNote] = await Promise.all([
        hasColumn("missions", "cancelled_by_user_id"),
        hasColumn("missions", "cancellation_reason"),
        hasColumn("missions", "cancellation_note"),
      ]);

      const assignments: string[] = [`status = 'annulee'`, `cancelled_at = NOW()`];
      const params: unknown[] = [];
      if (hasCancelBy) { assignments.push(`cancelled_by_user_id = ?`); params.push(req.user!.id); }
      if (hasCancelReason) { assignments.push(`cancellation_reason = ?`); params.push(payload.cancellation_reason ?? null); }
      if (hasCancelNote) { assignments.push(`cancellation_note = ?`); params.push(payload.cancellation_note ?? null); }
      assignments.push(`updated_at = NOW()`);

      await execute(`UPDATE missions SET ${assignments.join(", ")} WHERE id = ?`, [...params, mission.id]);

      await writeAuditLog(
        null,
        req.user!.id,
        "mission",
        mission.id,
        "cancelled",
        {
          cancelled_by: isClient ? "client" : "provider",
          cancellation_reason: payload.cancellation_reason ?? null,
          cancellation_note: payload.cancellation_note ?? null,
        },
        req.ip ?? null,
      );

      // Notifier l'autre partie
      const otherPartyUserId = isClient ? await getProviderUserId(mission.provider_profile_id) : mission.client_user_id;
      if (otherPartyUserId) {
        await createInAppNotification(null, otherPartyUserId, "mission_cancelled", "Mission annulee", `Ref #${String(mission.id).slice(-6)}`);
        void sendEventEmail({
          userId: otherPartyUserId,
          type: "mission_cancelled",
          title: "Mission annulee",
          body: `La mission a ete annulee par ${isClient ? "le client" : "le prestataire"}.`,
        });
      }

      return ok(res, await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [mission.id]));
    }),
  );

  router.get(
    "/conversations",
    asyncHandler(async (req, res) => {
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      const rows = await query<any>(
        `SELECT
            c.*,
            r.title AS request_title,
            (
              SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
              SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_at
           FROM conversations c
           LEFT JOIN requests r ON r.id = c.request_id
          WHERE c.client_user_id = ?` + (providerProfile ? " OR c.provider_profile_id = ?" : "") + ` ORDER BY COALESCE(last_message_at, c.updated_at) DESC`,
        providerProfile ? [req.user!.id, providerProfile.id] : [req.user!.id],
      );
      return ok(res, rows);
    }),
  );

  router.get(
    "/conversations/:id/messages",
    asyncHandler(async (req, res) => {
      await ensureConversationAccess(req.user!.id, String(req.params.id));
      return ok(res, await query<any>(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`, [String(req.params.id)]));
    }),
  );

  router.post(
    "/conversations/:id/messages",
    asyncHandler(async (req, res) => {
      const conversation = await ensureConversationAccess(req.user!.id, String(req.params.id));
      if (conversation.request_id && !conversation.mission_id) {
        const linkedRequest = await queryOne<{ status: string }>(`SELECT status FROM requests WHERE id = ?`, [conversation.request_id]);
        if (linkedRequest?.status === "cancelled") {
          throw new ApiError(400, "REQUEST_CANCELLED", "Cette demande a ete annulee, les messages ne sont plus acceptes.");
        }
      }
      const payload = conversationMessageCreateSchema.parse(req.body);
      const providerUserId = await getProviderUserId(conversation.provider_profile_id);
      const recipientUserId = conversation.client_user_id === req.user!.id ? providerUserId : conversation.client_user_id;

      const message = await withTransaction(async (connection) => {
        const messageId = createId("msg");
        await connection.execute(
          `INSERT INTO messages (id, conversation_id, sender_user_id, message_type, body, attachment_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [messageId, conversation.id, req.user!.id, payload.message_type, payload.body, payload.attachment_url ?? null],
        );
        await connection.execute(`UPDATE conversations SET updated_at = NOW() WHERE id = ?`, [conversation.id]);

        if (conversation.mission_id) {
          const clientSender = conversation.client_user_id === req.user!.id;
          await connection.execute(
            `UPDATE missions
                SET unread_messages_client_count = unread_messages_client_count + ?,
                    unread_messages_provider_count = unread_messages_provider_count + ?,
                    updated_at = NOW()
              WHERE id = ?`,
            [clientSender ? 0 : 1, clientSender ? 1 : 0, conversation.mission_id],
          );
        } else if (conversation.request_id) {
          const clientSender = conversation.client_user_id === req.user!.id;
          const requestColumns = await getRequestsColumnSupport();
          const requestAssignments = [
            ...(requestColumns.hasUnreadMessagesClientCount
              ? [`unread_messages_client_count = unread_messages_client_count + ?`]
              : []),
            ...(requestColumns.hasActionRequiredClient
              ? [`action_required_client = CASE WHEN ? = 1 THEN action_required_client ELSE 1 END`]
              : []),
            `updated_at = NOW()`,
          ];
          const requestParams = [
            ...(requestColumns.hasUnreadMessagesClientCount ? [clientSender ? 0 : 1] : []),
            ...(requestColumns.hasActionRequiredClient ? [clientSender ? 1 : 0] : []),
            conversation.request_id,
          ];
          await connection.execute(
            `UPDATE requests SET ${requestAssignments.join(", ")} WHERE id = ?`,
            requestParams,
          );
        }

        if (recipientUserId) {
          await createInAppNotification(connection, recipientUserId, "new_message", "Nouveau message", payload.body);
        }

        return ((await connection.query<any[]>(`SELECT * FROM messages WHERE id = ?`, [messageId]))[0] as any[])[0];
      });

      if (recipientUserId) {
        void sendEventEmail({ userId: recipientUserId, type: "new_message", title: "Nouveau message", body: payload.body });
      }
      return created(res, message);
    }),
  );

  router.patch(
    "/messages/:id",
    asyncHandler(async (req, res) => {
      const message = await queryOne<any>(
        `SELECT m.*, c.client_user_id, pp.user_id AS provider_user_id
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN provider_profiles pp ON pp.id = c.provider_profile_id
          WHERE m.id = ?`,
        [String(req.params.id)],
      );
      if (!message) {
        throw new ApiError(404, "MESSAGE_NOT_FOUND", "Message introuvable.");
      }
      if (message.client_user_id !== req.user!.id && message.provider_user_id !== req.user!.id) {
        throw new ApiError(403, "MESSAGE_FORBIDDEN", "Acces refuse a ce message.");
      }

      await execute(`UPDATE messages SET read_at = NOW() WHERE id = ?`, [message.id]);
      return ok(res, await queryOne<any>(`SELECT * FROM messages WHERE id = ?`, [message.id]));
    }),
  );

  router.get(
    "/notifications",
    asyncHandler(async (req, res) => ok(res, await query<any>(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC`, [req.user!.id]))),
  );

  router.post(
    "/notifications/read-all",
    asyncHandler(async (req, res) => {
      const result = await execute(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [req.user!.id]);
      return ok(res, { updated: Number(result.affectedRows ?? 0) });
    }),
  );

  router.get(
    "/notification-preferences",
    asyncHandler(async (req, res) => {
      let preferences = await queryOne<any>(`SELECT * FROM notification_preferences WHERE user_id = ?`, [req.user!.id]);
      if (!preferences) {
        const id = createId("npref");
        await execute(
          `INSERT INTO notification_preferences (
            id, user_id, email_messages_enabled, email_quotes_enabled, email_billing_enabled, email_marketing_enabled, push_enabled
          ) VALUES (?, ?, 1, 1, 0, 0, 0)`,
          [id, req.user!.id],
        );
        preferences = await queryOne<any>(`SELECT * FROM notification_preferences WHERE user_id = ?`, [req.user!.id]);
      }
      return ok(res, preferences);
    }),
  );

  router.patch(
    "/notification-preferences/:id",
    asyncHandler(async (req, res) => {
      const preferences = await queryOne<any>(`SELECT * FROM notification_preferences WHERE id = ? AND user_id = ?`, [String(req.params.id), req.user!.id]);
      if (!preferences) {
        throw new ApiError(404, "NOTIFICATION_PREFERENCES_NOT_FOUND", "Preferences introuvables.");
      }
      const payload = notificationPreferencesPatchSchema.parse(req.body);
      const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
      if (entries.length > 0) {
        await execute(
          `UPDATE notification_preferences SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...entries.map(([, value]) => (value ? 1 : 0)), preferences.id],
        );
      }
      return ok(res, await queryOne<any>(`SELECT * FROM notification_preferences WHERE id = ?`, [preferences.id]));
    }),
  );

  router.get(
    "/plans",
    asyncHandler(async (_req, res) => {
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      return ok(
        res,
        await query<any>(
          `SELECT id, code, name,
                  ${hasPlanBadge ? "badge" : "NULL AS badge"},
                  ${hasPlanMaxResponses ? "max_responses" : "response_limit AS max_responses"},
                  response_limit, priority_level, price_cents, currency, billing_interval, status
             FROM plans
            WHERE status = 'active'
            ORDER BY price_cents ASC, priority_level ASC`,
        ),
      );
    }),
  );

  router.get(
    "/subscriptions",
    asyncHandler(async (req, res) => {
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!providerProfile) return ok(res, []);
      const rows = await query<any>(
        `SELECT s.*, p.code AS plan_code, p.name AS plan_name,
                ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
                ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
                p.response_limit, p.priority_level
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.provider_profile_id = ?
          ORDER BY s.updated_at DESC`,
        [providerProfile.id],
      );
      return ok(res, rows);
    }),
  );

  router.post(
    "/subscriptions/activate",
    asyncHandler(async (req, res) => {
      const payload = activateSubscriptionSchema.parse(req.body);
      const providerProfile = await getProviderProfileForUser(req.user!.id);
      const plan = await queryOne<any>(`SELECT * FROM plans WHERE id = ? AND status = 'active'`, [payload.plan_id]);
      if (!plan) {
        throw new ApiError(404, "PLAN_NOT_FOUND", "Plan introuvable.");
      }

      const subscription = await withTransaction(async (connection) => {
        const hasPlanBadge = await hasColumn("plans", "badge");
        const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
        await connection.execute(`UPDATE subscriptions SET status = 'expired', ends_at = NOW(), updated_at = NOW() WHERE provider_profile_id = ? AND status = 'active'`, [providerProfile.id]);
        const subscriptionId = createId("sub");
        await connection.execute(
          `INSERT INTO subscriptions (id, user_id, provider_profile_id, plan_id, status, starts_at, ends_at)
           VALUES (?, ?, ?, ?, 'active', NOW(), NULL)`,
          [subscriptionId, req.user!.id, providerProfile.id, plan.id],
        );
        await createInAppNotification(connection, req.user!.id, "subscription_updated", "Abonnement active", plan.name);
        return ((await connection.query<any[]>(
          `SELECT s.*, p.code AS plan_code, p.name AS plan_name,
                  ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
                  ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
                  p.response_limit, p.priority_level
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
            WHERE s.id = ?`,
          [subscriptionId],
        ))[0] as any[])[0];
      });

      void sendEventEmail({ userId: req.user!.id, type: "subscription_updated", title: "Abonnement active", body: plan.name });
      return created(res, subscription);
    }),
  );

  router.post(
    "/subscriptions/checkout",
    authRequired,
    asyncHandler(async (req, res) => {
      const payload = activateSubscriptionSchema.parse(req.body);
      const providerProfile = await getProviderProfileForUser(req.user!.id);
      const plan = await queryOne<any>(`SELECT * FROM plans WHERE id = ? AND status = 'active'`, [payload.plan_id]);
      if (!plan) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan introuvable.");

      // Free plan: activate directly
      if (Number(plan.price_cents) === 0) {
        const subscription = await withTransaction(async (connection) => {
          const hasPlanBadge = await hasColumn("plans", "badge");
          const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
          await connection.execute(`UPDATE subscriptions SET status = 'expired', ends_at = NOW(), updated_at = NOW() WHERE provider_profile_id = ? AND status = 'active'`, [providerProfile.id]);
          const subscriptionId = createId("sub");
          await connection.execute(
            `INSERT INTO subscriptions (id, user_id, provider_profile_id, plan_id, status, starts_at, ends_at)
             VALUES (?, ?, ?, ?, 'active', NOW(), NULL)`,
            [subscriptionId, req.user!.id, providerProfile.id, plan.id],
          );
          await createInAppNotification(connection, req.user!.id, "subscription_updated", "Abonnement active", plan.name);
          return ((await connection.query<any[]>(
            `SELECT s.*, p.code AS plan_code, p.name AS plan_name,
                    ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
                    ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
                    p.response_limit, p.priority_level
               FROM subscriptions s
               JOIN plans p ON p.id = s.plan_id
              WHERE s.id = ?`,
            [subscriptionId],
          ))[0] as any[])[0];
        });
        void sendEventEmail({ userId: req.user!.id, type: "subscription_updated", title: "Abonnement active", body: plan.name });
        return created(res, { subscription, checkout_url: null });
      }

      // Paid plan: Stripe Checkout session
      const priceId = await getOrCreateStripePriceForPlan(plan);
      const stripe = getStripeClient();

      await execute(`UPDATE subscriptions SET status = 'expired', ends_at = NOW(), updated_at = NOW() WHERE provider_profile_id = ? AND status = 'active'`, [providerProfile.id]);
      const subscriptionId = createId("sub");
      await execute(
        `INSERT INTO subscriptions (id, user_id, provider_profile_id, plan_id, status, starts_at, ends_at)
         VALUES (?, ?, ?, ?, 'draft', NULL, NULL)`,
        [subscriptionId, req.user!.id, providerProfile.id, plan.id],
      );

      const frontendUrl = (process.env.FRONTEND_URL ?? "http://localhost:3003").replace(/\/$/, "");
      const successUrl = payload.success_url ?? `${frontendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = payload.cancel_url ?? `${frontendUrl}/checkout/cancel`;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: req.user!.email,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          local_subscription_id: subscriptionId,
          user_id: req.user!.id,
        },
        subscription_data: {
          metadata: {
            local_subscription_id: subscriptionId,
            user_id: req.user!.id,
          },
        },
      });

      return ok(res, { subscription: null, checkout_url: session.url });
    }),
  );

  router.get(
    "/reviews",
    asyncHandler(async (req, res) => {
      const providerId = typeof req.query.target_provider_profile_id === "string" ? req.query.target_provider_profile_id : null;
      const targetUserId = typeof req.query.target_user_id === "string" ? req.query.target_user_id : null;
      let sql = `SELECT r.*, u.first_name AS author_first_name, u.last_name AS author_last_name FROM reviews r JOIN users u ON u.id = r.author_user_id`;
      const params: any[] = [];
      if (providerId) { sql += ` WHERE r.target_provider_profile_id = ?`; params.push(providerId); }
      else if (targetUserId) { sql += ` WHERE r.target_user_id = ?`; params.push(targetUserId); }
      sql += ` ORDER BY r.created_at DESC`;
      const rows = await query<any>(sql, params);
      return ok(res, rows);
    }),
  );

  router.post(
    "/reviews",
    asyncHandler(async (req, res) => {
      const payload = reviewCreateSchema.parse(req.body);
      const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [payload.mission_id]);
      if (!mission) throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      if (mission.status !== "terminee") throw new ApiError(400, "MISSION_NOT_REVIEWABLE", "La mission doit etre terminee.");

      const isClient = mission.client_user_id === req.user!.id;

      // Identify if the caller is the provider for this mission
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      const isProvider = providerProfile && mission.provider_profile_id === providerProfile.id;

      if (!isClient && !isProvider) {
        throw new ApiError(403, "REVIEW_FORBIDDEN", "Vous ne participez pas a cette mission.");
      }

      // Client must target provider; provider must target client
      if (isClient && !payload.target_provider_profile_id) {
        throw new ApiError(400, "REVIEW_MISSING_TARGET", "Le client doit cibler le prestataire.");
      }
      if (isProvider && !payload.target_user_id) {
        throw new ApiError(400, "REVIEW_MISSING_TARGET", "Le prestataire doit cibler le client.");
      }

      // Prevent duplicate review for this direction
      const existingReview = await queryOne<any>(`SELECT id FROM reviews WHERE mission_id = ? AND author_user_id = ?`, [mission.id, req.user!.id]);
      if (existingReview) throw new ApiError(409, "REVIEW_ALREADY_EXISTS", "Un avis existe deja pour cette mission.");

      const reviewId = createId("rev");
      await execute(
        `INSERT INTO reviews (id, mission_id, author_user_id, target_provider_profile_id, target_user_id, rating, comment, status, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'published', NOW())`,
        [reviewId, mission.id, req.user!.id, payload.target_provider_profile_id ?? null, payload.target_user_id ?? null, payload.rating, payload.comment ?? null],
      );

      // Refresh provider aggregate rating when provider is the target
      if (payload.target_provider_profile_id) {
        await refreshProviderRating(payload.target_provider_profile_id);
      }

      return created(res, await queryOne<any>(`SELECT * FROM reviews WHERE id = ?`, [reviewId]));
    }),
  );

  // Reviews received by current user as a client (provider → client direction)
  router.get(
    "/reviews/my-reputation",
    asyncHandler(async (req, res) => {
      const rows = await query<any>(
        `SELECT r.*, u.first_name AS author_first_name, u.last_name AS author_last_name,
                pp.display_name AS author_display_name, pp.business_name AS author_business_name
           FROM reviews r
           JOIN users u ON u.id = r.author_user_id
           LEFT JOIN provider_profiles pp ON pp.user_id = r.author_user_id
          WHERE r.target_user_id = ?
            AND r.status = 'published'
          ORDER BY r.created_at DESC`,
        [req.user!.id],
      );
      return ok(res, rows);
    }),
  );

  router.get(
    "/disputes",
    asyncHandler(async (req, res) => {
      const providerProfile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      const rows = await query<any>(
        `SELECT d.*
           FROM disputes d
           LEFT JOIN missions m ON m.id = d.mission_id
          WHERE d.opened_by_user_id = ?
             OR d.against_user_id = ?` + (providerProfile ? ` OR m.provider_profile_id = ?` : "") + ` ORDER BY d.created_at DESC`,
        providerProfile ? [req.user!.id, req.user!.id, providerProfile.id] : [req.user!.id, req.user!.id],
      );
      return ok(res, rows);
    }),
  );

  router.post(
    "/disputes",
    asyncHandler(async (req, res) => {
      const payload = disputeCreateSchema.parse(req.body);
      if (!payload.mission_id && !payload.request_id) {
        throw new ApiError(400, "DISPUTE_CONTEXT_REQUIRED", "Un litige doit etre rattache a une mission ou une demande.");
      }

      let againstUserId = payload.against_user_id ?? null;
      if (payload.mission_id) {
        const mission = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [payload.mission_id]);
        if (!mission) {
          throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
        }
        if (!againstUserId) {
          againstUserId = mission.client_user_id === req.user!.id ? await getProviderUserId(mission.provider_profile_id) : mission.client_user_id;
        }
        await execute(`UPDATE missions SET status = 'en_litige', dispute_opened = 1, updated_at = NOW() WHERE id = ?`, [mission.id]);
      }

      const disputeId = createId("disp");
      await execute(
        `INSERT INTO disputes (id, mission_id, request_id, opened_by_user_id, against_user_id, category, description, status, resolution_type, resolution_note, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`,
        [disputeId, payload.mission_id ?? null, payload.request_id ?? null, req.user!.id, againstUserId, payload.category, payload.description],
      );

      await createInAppNotification(null, req.user!.id, "dispute_opened", "Litige ouvert", payload.category);
      void sendEventEmail({ userId: req.user!.id, type: "dispute_opened", title: "Litige ouvert", body: payload.category });
      if (againstUserId) {
        await createInAppNotification(null, againstUserId, "dispute_opened", "Litige ouvert", payload.category);
        void sendEventEmail({ userId: againstUserId, type: "dispute_opened", title: "Litige ouvert", body: payload.category });
      }

      return created(res, await queryOne<any>(`SELECT * FROM disputes WHERE id = ?`, [disputeId]));
    }),
  );

  router.get(
    "/disputes/:id/messages",
    asyncHandler(async (req, res) => {
      await ensureDisputeAccess(req.user!.id, String(req.params.id));
      return ok(res, await query<any>(`SELECT * FROM dispute_messages WHERE dispute_id = ? ORDER BY created_at ASC`, [String(req.params.id)]));
    }),
  );

  router.post(
    "/disputes/:id/messages",
    asyncHandler(async (req, res) => {
      const dispute = await ensureDisputeAccess(req.user!.id, String(req.params.id));
      const payload = disputeMessageCreateSchema.parse(req.body);
      const messageId = createId("dmsg");
      await execute(
        `INSERT INTO dispute_messages (id, dispute_id, sender_user_id, body, attachment_url)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, dispute.id, req.user!.id, payload.body, payload.attachment_url ?? null],
      );
      return created(res, await queryOne<any>(`SELECT * FROM dispute_messages WHERE id = ?`, [messageId]));
    }),
  );

  // ── Push subscriptions ────────────────────────────────────────────────────
  const pushSubscribeSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  });

  router.get(
    "/push/vapid-key",
    asyncHandler(async (_req, res) => {
      const publicKey = getVapidPublicKey();
      if (!publicKey) {
        throw new ApiError(503, "PUSH_NOT_CONFIGURED", "Push notifications non configurees.");
      }
      return ok(res, { public_key: publicKey });
    }),
  );

  router.post(
    "/push/subscribe",
    authRequired,
    asyncHandler(async (req, res) => {
      const payload = pushSubscribeSchema.parse(req.body);
      await ensurePushSubscriptionsTable();
      await upsertPushSubscription(req.user!.id, payload.endpoint, payload.keys.p256dh, payload.keys.auth);
      return ok(res, { subscribed: true });
    }),
  );

  router.delete(
    "/push/subscribe",
    authRequired,
    asyncHandler(async (req, res) => {
      const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
      await removeUserPushSubscription(req.user!.id, endpoint);
      return ok(res, { unsubscribed: true });
    }),
  );

  return router;
}
