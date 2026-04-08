import { Router } from "express";
import { z } from "zod";
import { authRequired, requirePermission, requireRole } from "../core/auth";
import { execute, hasColumn, query, queryOne } from "../core/db";
import { ApiError } from "../core/errors";
import { asyncHandler, created, ok } from "../core/http";
import { createId } from "../core/store";

const platformSettingsPatchSchema = z.object({
  currency: z.string().min(1).max(10).optional(),
  default_locale: z.string().min(2).max(10).optional(),
  supported_locales: z.array(z.string().min(2).max(10)).optional(),
  brand_logo_url: z.string().nullable().optional(),
  pwa_push_enabled: z.coerce.boolean().optional(),
  request_auto_expiry_days: z.number().int().min(1).max(90).optional(),
  request_publication_payment_enabled: z.coerce.boolean().optional(),
  default_request_publication_price_cents: z.number().int().min(0).optional(),
});

const categoryCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  marketing_title: z.string().nullable().optional(),
  marketing_subtitle: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  sort_order: z.number().int().min(0).default(0),
});

const categoryPatchSchema = categoryCreateSchema.partial();

const requestPatchSchema = z.object({
  status: z.enum(["draft", "published", "in_discussion", "awarded", "expired", "cancelled", "closed"]).optional(),
  action_required_client: z.boolean().optional(),
});

const quotePatchSchema = z.object({
  status: z.enum(["sent", "accepted", "rejected", "withdrawn"]).optional(),
  delay_days: z.number().int().min(0).nullable().optional(),
  indicative_price_cents: z.number().int().min(0).nullable().optional(),
});

const missionPatchSchema = z.object({
  status: z.enum(["confirmee", "planifiee", "en_cours", "terminee", "annulee", "en_litige"]).optional(),
  dispute_opened: z.boolean().optional(),
});

const subscriptionPatchSchema = z.object({
  status: z.enum(["draft", "active", "expired", "cancelled"]).optional(),
  ends_at: z.string().nullable().optional(),
});

const disputePatchSchema = z.object({
  status: z.enum(["open", "resolved"]).optional(),
  resolution_type: z.string().nullable().optional(),
  resolution_note: z.string().nullable().optional(),
  resolved_at: z.string().nullable().optional(),
});

const planCreateSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  badge: z.string().nullable().optional(),
  max_responses: z.number().int().min(0).nullable().optional(),
  priority_level: z.number().int().min(0).max(255).default(0),
  price_cents: z.number().int().min(0).default(0),
  currency: z.string().min(1).max(10).default("CAD"),
  status: z.enum(["active", "inactive"]).default("active"),
});

const userCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  phone: z.string().nullable().optional(),
  locale: z.string().default("fr-CA"),
  is_client_enabled: z.boolean().default(true),
  is_provider_enabled: z.boolean().default(false),
  status: z.enum(["active", "suspended"]).default("active"),
});

const userPatchSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  is_client_enabled: z.boolean().optional(),
  is_provider_enabled: z.boolean().optional(),
  email: z.string().email().optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  phone: z.string().nullable().optional(),
  locale: z.string().optional(),
});

const serviceCreateSchema = z.object({
  category_id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  marketing_title: z.string().nullable().optional(),
  price_label: z.string().nullable().optional(),
  base_publication_price_cents: z.number().int().min(0).nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  sort_order: z.number().int().min(0).default(0),
});

const servicePatchSchema = serviceCreateSchema.partial();

const planPatchSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  badge: z.string().nullable().optional(),
  max_responses: z.number().int().min(0).nullable().optional(),
  priority_level: z.number().int().min(0).max(255).optional(),
  price_cents: z.number().int().min(0).optional(),
  currency: z.string().min(1).max(10).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

function parseInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pushSearchClause(whereParts: string[], params: unknown[], value: unknown, columns: string[]) {
  if (typeof value !== "string" || value.trim().length === 0) return;
  const search = `%${value.trim()}%`;
  whereParts.push(`(${columns.map((column) => `${column} LIKE ?`).join(" OR ")})`);
  params.push(...columns.map(() => search));
}

function withWhere(baseSql: string, whereParts: string[]) {
  return whereParts.length > 0 ? `${baseSql} WHERE ${whereParts.join(" AND ")}` : baseSql;
}

async function scalar(sql: string, params: unknown[] = []) {
  const row = await queryOne<Record<string, unknown>>(sql, params);
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

async function paginatedList(req: any, baseSql: string, countSql: string, params: unknown[] = []) {
  const page = parseInteger(req.query.page, 1);
  const limit = Math.min(parseInteger(req.query.limit, 20), 100);
  const offset = (page - 1) * limit;
  const [items, total] = await Promise.all([
    query(`${baseSql} LIMIT ? OFFSET ?`, [...params, limit, offset]),
    scalar(countSql, params),
  ]);
  return { items, meta: { page, limit, total } };
}

async function applyPatch(table: string, id: string, payload: Record<string, unknown>) {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  await execute(
    `UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
    [...entries.map(([, value]) => value), id],
  );
}

export function adminRouter() {
  const router = Router();

  router.use(authRequired, requireRole("admin"));

  router.get(
    "/admin/me/access",
    asyncHandler(async (req, res) =>
      ok(res, {
        role: req.role,
        admin_role_codes: req.adminRoleCodes ?? [],
        admin_permissions: req.adminPermissions ?? [],
      }),
    ),
  );

  router.get(
    "/admin/overview",
    requirePermission("dashboard.view"),
    asyncHandler(async (_req, res) => {
      const [
        users,
        providers,
        requests,
        openRequests,
        quotes,
        missions,
        activeMissions,
        disputes,
        activeSubscriptions,
        unreadNotifications,
      ] = await Promise.all([
        scalar(`SELECT COUNT(*) AS total FROM users WHERE status <> 'deleted'`),
        scalar(`SELECT COUNT(*) AS total FROM provider_profiles WHERE provider_status = 'active'`),
        scalar(`SELECT COUNT(*) AS total FROM requests`),
        scalar(`SELECT COUNT(*) AS total FROM requests WHERE status IN ('published', 'in_discussion')`),
        scalar(`SELECT COUNT(*) AS total FROM quotes WHERE status = 'sent'`),
        scalar(`SELECT COUNT(*) AS total FROM missions`),
        scalar(`SELECT COUNT(*) AS total FROM missions WHERE status IN ('confirmee', 'planifiee', 'en_cours')`),
        scalar(`SELECT COUNT(*) AS total FROM disputes WHERE status = 'open'`),
        scalar(`SELECT COUNT(*) AS total FROM subscriptions WHERE status = 'active'`),
        scalar(`SELECT COUNT(*) AS total FROM notifications WHERE is_read = 0`),
      ]);

      return ok(res, {
        users,
        providers,
        requests,
        open_requests: openRequests,
        quotes_waiting: quotes,
        missions,
        active_missions: activeMissions,
        open_disputes: disputes,
        active_subscriptions: activeSubscriptions,
        unread_notifications: unreadNotifications,
      });
    }),
  );

  router.get(
    "/admin/platform-settings",
    requirePermission("platform.view"),
    asyncHandler(async (_req, res) => ok(res, await queryOne(`SELECT * FROM platform_settings WHERE id = 1`))),
  );

  router.patch(
    "/admin/platform-settings",
    requirePermission("platform.edit"),
    asyncHandler(async (req, res) => {
      const payload = platformSettingsPatchSchema.parse(req.body);
      const [hasAutoExpiryDays, hasPaymentEnabled, hasPaymentPrice] = await Promise.all([
        hasColumn("platform_settings", "request_auto_expiry_days"),
        hasColumn("platform_settings", "request_publication_payment_enabled"),
        hasColumn("platform_settings", "default_request_publication_price_cents"),
      ]);
      const updatePayload: Record<string, unknown> = {
        ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
        ...(payload.default_locale !== undefined ? { default_locale: payload.default_locale } : {}),
        ...(payload.supported_locales !== undefined ? { supported_locales: JSON.stringify(payload.supported_locales) } : {}),
        ...(payload.brand_logo_url !== undefined ? { brand_logo_url: payload.brand_logo_url } : {}),
        ...(payload.pwa_push_enabled !== undefined ? { pwa_push_enabled: payload.pwa_push_enabled ? 1 : 0 } : {}),
        ...(hasAutoExpiryDays && payload.request_auto_expiry_days !== undefined ? { request_auto_expiry_days: payload.request_auto_expiry_days } : {}),
        ...(hasPaymentEnabled && payload.request_publication_payment_enabled !== undefined ? { request_publication_payment_enabled: payload.request_publication_payment_enabled ? 1 : 0 } : {}),
        ...(hasPaymentPrice && payload.default_request_publication_price_cents !== undefined ? { default_request_publication_price_cents: payload.default_request_publication_price_cents } : {}),
      };

      await applyPatch("platform_settings", "1", updatePayload);
      return ok(res, await queryOne(`SELECT * FROM platform_settings WHERE id = 1`));
    }),
  );

  router.get(
    "/admin/requests",
    requirePermission("requests.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.status === "string") {
        whereParts.push("r.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["r.title", "r.description", "u.email"]);

      const baseSql =
        withWhere(
          `SELECT r.*, u.email AS client_email, s.name AS service_name, z.name AS zone_name
             FROM requests r
             JOIN users u ON u.id = r.client_user_id
             JOIN services s ON s.id = r.service_id
             JOIN zones z ON z.id = r.zone_id`,
          whereParts,
        ) + ` ORDER BY r.updated_at DESC`;

      const countSql = withWhere(`SELECT COUNT(*) AS total FROM requests r JOIN users u ON u.id = r.client_user_id`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/requests/:id",
    requirePermission("requests.edit"),
    asyncHandler(async (req, res) => {
      const requestId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM requests WHERE id = ?`, [requestId]);
      if (!existing) throw new ApiError(404, "REQUEST_NOT_FOUND", "Demande introuvable.");
      const payload = requestPatchSchema.parse(req.body);
      await applyPatch("requests", requestId, {
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.action_required_client !== undefined ? { action_required_client: payload.action_required_client ? 1 : 0 } : {}),
      });
      return ok(res, await queryOne(`SELECT * FROM requests WHERE id = ?`, [requestId]));
    }),
  );

  router.get(
    "/admin/quotes",
    requirePermission("quotes.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.status === "string") {
        whereParts.push("q.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["q.message", "r.title", "pp.business_name", "pp.display_name"]);

      const baseSql =
        withWhere(
          `SELECT q.*, r.title AS request_title, pp.display_name, pp.business_name
             FROM quotes q
             JOIN requests r ON r.id = q.request_id
             JOIN provider_profiles pp ON pp.id = q.provider_profile_id`,
          whereParts,
        ) + ` ORDER BY q.updated_at DESC`;
      const countSql = withWhere(`SELECT COUNT(*) AS total FROM quotes q JOIN requests r ON r.id = q.request_id JOIN provider_profiles pp ON pp.id = q.provider_profile_id`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/quotes/:id",
    requirePermission("quotes.edit"),
    asyncHandler(async (req, res) => {
      const quoteId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM quotes WHERE id = ?`, [quoteId]);
      if (!existing) throw new ApiError(404, "QUOTE_NOT_FOUND", "Offre introuvable.");
      const payload = quotePatchSchema.parse(req.body);
      await applyPatch("quotes", quoteId, payload);
      return ok(res, await queryOne(`SELECT * FROM quotes WHERE id = ?`, [quoteId]));
    }),
  );

  router.get(
    "/admin/missions",
    requirePermission("missions.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.status === "string") {
        whereParts.push("m.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["r.title", "pp.business_name", "pp.display_name"]);

      const baseSql =
        withWhere(
          `SELECT m.*, r.title AS request_title, pp.display_name, pp.business_name
             FROM missions m
             JOIN requests r ON r.id = m.request_id
             JOIN provider_profiles pp ON pp.id = m.provider_profile_id`,
          whereParts,
        ) + ` ORDER BY m.updated_at DESC`;
      const countSql = withWhere(`SELECT COUNT(*) AS total FROM missions m JOIN requests r ON r.id = m.request_id JOIN provider_profiles pp ON pp.id = m.provider_profile_id`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/missions/:id",
    requirePermission("missions.edit"),
    asyncHandler(async (req, res) => {
      const missionId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM missions WHERE id = ?`, [missionId]);
      if (!existing) throw new ApiError(404, "MISSION_NOT_FOUND", "Mission introuvable.");
      const payload = missionPatchSchema.parse(req.body);
      await applyPatch("missions", missionId, {
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.dispute_opened !== undefined ? { dispute_opened: payload.dispute_opened ? 1 : 0 } : {}),
      });
      return ok(res, await queryOne(`SELECT * FROM missions WHERE id = ?`, [missionId]));
    }),
  );

  router.get(
    "/admin/subscriptions",
    requirePermission("subscriptions.view"),
    asyncHandler(async (req, res) => {
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.status === "string") {
        whereParts.push("s.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["p.name", "pp.business_name", "pp.display_name", "u.email"]);

      const baseSql =
        withWhere(
          `SELECT s.*, p.name AS plan_name,
                  ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
                  ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
                  p.priority_level, u.email, pp.display_name, pp.business_name
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
             JOIN users u ON u.id = s.user_id
             JOIN provider_profiles pp ON pp.id = s.provider_profile_id`,
          whereParts,
        ) + ` ORDER BY s.updated_at DESC`;
      const countSql = withWhere(`SELECT COUNT(*) AS total FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN users u ON u.id = s.user_id JOIN provider_profiles pp ON pp.id = s.provider_profile_id`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/subscriptions/:id",
    requirePermission("subscriptions.edit"),
    asyncHandler(async (req, res) => {
      const subscriptionId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM subscriptions WHERE id = ?`, [subscriptionId]);
      if (!existing) throw new ApiError(404, "SUBSCRIPTION_NOT_FOUND", "Abonnement introuvable.");
      const payload = subscriptionPatchSchema.parse(req.body);
      await applyPatch("subscriptions", subscriptionId, payload);
      return ok(res, await queryOne(`SELECT * FROM subscriptions WHERE id = ?`, [subscriptionId]));
    }),
  );

  router.get(
    "/admin/disputes",
    requirePermission("disputes.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.status === "string") {
        whereParts.push("d.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["d.category", "d.description"]);

      const baseSql = withWhere(`SELECT d.* FROM disputes d`, whereParts) + ` ORDER BY d.updated_at DESC`;
      const countSql = withWhere(`SELECT COUNT(*) AS total FROM disputes d`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/disputes/:id",
    requirePermission("disputes.edit"),
    asyncHandler(async (req, res) => {
      const disputeId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM disputes WHERE id = ?`, [disputeId]);
      if (!existing) throw new ApiError(404, "DISPUTE_NOT_FOUND", "Litige introuvable.");
      const payload = disputePatchSchema.parse(req.body);
      await applyPatch("disputes", disputeId, payload);
      return ok(res, await queryOne(`SELECT * FROM disputes WHERE id = ?`, [disputeId]));
    }),
  );

  router.get(
    "/admin/plans",
    requirePermission("plans.view"),
    asyncHandler(async (_req, res) => {
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      return ok(
        res,
        await query(
          `SELECT p.*,
                  ${hasPlanBadge ? "p.badge" : "NULL AS badge"},
                  ${hasPlanMaxResponses ? "p.max_responses" : "p.response_limit AS max_responses"},
                  (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_subscriptions_count
             FROM plans p
            ORDER BY p.price_cents ASC, p.priority_level ASC`,
        ),
      );
    }),
  );

  router.post(
    "/admin/plans",
    requirePermission("plans.edit"),
    asyncHandler(async (req, res) => {
      const payload = planCreateSchema.parse(req.body);
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      const planId = createId("plan");
      const columns = ["id", "code", "name"];
      const values: unknown[] = [planId, payload.code, payload.name];
      if (hasPlanBadge) {
        columns.push("badge");
        values.push(payload.badge ?? null);
      }
      if (hasPlanMaxResponses) {
        columns.push("max_responses");
        values.push(payload.max_responses ?? null);
      }
      columns.push("response_limit", "priority_level", "price_cents", "currency", "billing_interval", "status");
      values.push(payload.max_responses ?? null, payload.priority_level, payload.price_cents, payload.currency, "monthly", payload.status);
      await execute(
        `INSERT INTO plans (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
        values,
      );
      return created(res, await queryOne(`SELECT * FROM plans WHERE id = ?`, [planId]));
    }),
  );

  router.patch(
    "/admin/plans/:id",
    requirePermission("plans.edit"),
    asyncHandler(async (req, res) => {
      const planId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM plans WHERE id = ?`, [planId]);
      if (!existing) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan introuvable.");

      const payload = planPatchSchema.parse(req.body);
      const hasPlanBadge = await hasColumn("plans", "badge");
      const hasPlanMaxResponses = await hasColumn("plans", "max_responses");
      const updatePayload: Record<string, unknown> = {
        ...(payload.code !== undefined ? { code: payload.code } : {}),
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(hasPlanBadge && payload.badge !== undefined ? { badge: payload.badge } : {}),
        ...(hasPlanMaxResponses && payload.max_responses !== undefined ? { max_responses: payload.max_responses } : {}),
        ...(payload.max_responses !== undefined ? { response_limit: payload.max_responses } : {}),
        ...(payload.priority_level !== undefined ? { priority_level: payload.priority_level } : {}),
        ...(payload.price_cents !== undefined ? { price_cents: payload.price_cents } : {}),
        ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      };

      await applyPatch("plans", planId, updatePayload);
      return ok(res, await queryOne(`SELECT * FROM plans WHERE id = ?`, [planId]));
    }),
  );

  router.get(
    "/admin/categories",
    requirePermission("platform.view"),
    asyncHandler(async (_req, res) => {
      const hasIcon = await hasColumn("categories", "icon");
      return ok(
        res,
        await query(
          `SELECT id, name, slug, description, image_url, ${hasIcon ? "icon" : "NULL AS icon"}, marketing_title, marketing_subtitle, status, sort_order, created_at, updated_at
             FROM categories
            ORDER BY sort_order ASC, name ASC`,
        ),
      );
    }),
  );

  router.post(
    "/admin/categories",
    requirePermission("platform.edit"),
    asyncHandler(async (req, res) => {
      const payload = categoryCreateSchema.parse(req.body);
      const hasIcon = await hasColumn("categories", "icon");
      const categoryId = createId("cat");
      const columns = ["id", "name", "slug", "description", "image_url", "marketing_title", "marketing_subtitle", "status", "sort_order"];
      const values: unknown[] = [categoryId, payload.name, payload.slug, payload.description ?? null, payload.image_url ?? null, payload.marketing_title ?? null, payload.marketing_subtitle ?? null, payload.status, payload.sort_order];
      if (hasIcon) {
        columns.push("icon");
        values.push(payload.icon ?? null);
      }
      await execute(
        `INSERT INTO categories (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        values,
      );
      const hasIconSelect = await hasColumn("categories", "icon");
      return created(res, await queryOne(`SELECT id, name, slug, description, image_url, ${hasIconSelect ? "icon" : "NULL AS icon"}, marketing_title, marketing_subtitle, status, sort_order, created_at, updated_at FROM categories WHERE id = ?`, [categoryId]));
    }),
  );

  router.patch(
    "/admin/categories/:id",
    requirePermission("platform.edit"),
    asyncHandler(async (req, res) => {
      const categoryId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM categories WHERE id = ?`, [categoryId]);
      if (!existing) throw new ApiError(404, "CATEGORY_NOT_FOUND", "Catégorie introuvable.");
      const payload = categoryPatchSchema.parse(req.body);
      const hasIcon = await hasColumn("categories", "icon");
      const updatePayload: Record<string, unknown> = {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.image_url !== undefined ? { image_url: payload.image_url } : {}),
        ...(hasIcon && payload.icon !== undefined ? { icon: payload.icon } : {}),
        ...(payload.marketing_title !== undefined ? { marketing_title: payload.marketing_title } : {}),
        ...(payload.marketing_subtitle !== undefined ? { marketing_subtitle: payload.marketing_subtitle } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.sort_order !== undefined ? { sort_order: payload.sort_order } : {}),
      };
      await applyPatch("categories", categoryId, updatePayload);
      const hasIconSelect = await hasColumn("categories", "icon");
      return ok(res, await queryOne(`SELECT id, name, slug, description, image_url, ${hasIconSelect ? "icon" : "NULL AS icon"}, marketing_title, marketing_subtitle, status, sort_order, created_at, updated_at FROM categories WHERE id = ?`, [categoryId]));
    }),
  );

  router.post(
    "/admin/users",
    requirePermission("users.edit"),
    asyncHandler(async (req, res) => {
      const payload = userCreateSchema.parse(req.body);
      const existing = await queryOne<any>(`SELECT id FROM users WHERE email = ?`, [payload.email]);
      if (existing) throw new ApiError(409, "EMAIL_ALREADY_EXISTS", "Un compte existe deja avec cet email.");
      const userId = createId("usr");
      await execute(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, locale, is_client_enabled, is_provider_enabled, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, payload.email, payload.password, payload.first_name, payload.last_name, payload.phone ?? null, payload.locale, payload.is_client_enabled ? 1 : 0, payload.is_provider_enabled ? 1 : 0, payload.status],
      );
      return created(res, await queryOne(`SELECT id, email, first_name, last_name, phone, locale, status, is_client_enabled, is_provider_enabled, email_verified_at, created_at, updated_at FROM users WHERE id = ?`, [userId]));
    }),
  );

  router.get(
    "/admin/users",
    requirePermission("users.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = ["u.status <> 'deleted'"];
      const params: unknown[] = [];
      if (typeof req.query.status === "string" && req.query.status) {
        whereParts.push("u.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["u.email", "u.first_name", "u.last_name"]);

      const baseSql =
        withWhere(
          `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.status,
                  u.is_client_enabled, u.is_provider_enabled, u.email_verified_at,
                  u.created_at, u.updated_at,
                  (SELECT COUNT(*) FROM requests r WHERE r.client_user_id = u.id) AS requests_count,
                  (SELECT COUNT(*) FROM provider_profiles pp WHERE pp.user_id = u.id) AS has_provider_profile
             FROM users u`,
          whereParts,
        ) + ` ORDER BY u.created_at DESC`;

      const countSql = withWhere(`SELECT COUNT(*) AS total FROM users u`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.patch(
    "/admin/users/:id",
    requirePermission("users.edit"),
    asyncHandler(async (req, res) => {
      const userId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM users WHERE id = ?`, [userId]);
      if (!existing) throw new ApiError(404, "USER_NOT_FOUND", "Utilisateur introuvable.");
      const payload = userPatchSchema.parse(req.body);
      if (payload.email && payload.email !== existing.email) {
        const emailTaken = await queryOne<any>(`SELECT id FROM users WHERE email = ? AND id <> ?`, [payload.email, userId]);
        if (emailTaken) throw new ApiError(409, "EMAIL_ALREADY_EXISTS", "Cet email est deja utilise.");
      }
      await applyPatch("users", userId, {
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.is_client_enabled !== undefined ? { is_client_enabled: payload.is_client_enabled ? 1 : 0 } : {}),
        ...(payload.is_provider_enabled !== undefined ? { is_provider_enabled: payload.is_provider_enabled ? 1 : 0 } : {}),
        ...(payload.email !== undefined ? { email: payload.email } : {}),
        ...(payload.first_name !== undefined ? { first_name: payload.first_name } : {}),
        ...(payload.last_name !== undefined ? { last_name: payload.last_name } : {}),
        ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
        ...(payload.locale !== undefined ? { locale: payload.locale } : {}),
      });
      return ok(res, await queryOne(`SELECT id, email, first_name, last_name, phone, status, is_client_enabled, is_provider_enabled, email_verified_at, created_at, updated_at FROM users WHERE id = ?`, [userId]));
    }),
  );

  router.get(
    "/admin/services",
    requirePermission("platform.view"),
    asyncHandler(async (req, res) => {
      const whereParts: string[] = [];
      const params: unknown[] = [];
      if (typeof req.query.category_id === "string" && req.query.category_id) {
        whereParts.push("s.category_id = ?");
        params.push(req.query.category_id);
      }
      if (typeof req.query.status === "string" && req.query.status) {
        whereParts.push("s.status = ?");
        params.push(req.query.status);
      }
      pushSearchClause(whereParts, params, req.query.q, ["s.name", "s.slug", "s.description"]);

      const baseSql =
        withWhere(
          `SELECT s.*, c.name AS category_name
             FROM services s
             JOIN categories c ON c.id = s.category_id`,
          whereParts,
        ) + ` ORDER BY s.sort_order ASC, s.name ASC`;

      const countSql = withWhere(`SELECT COUNT(*) AS total FROM services s JOIN categories c ON c.id = s.category_id`, whereParts);
      const result = await paginatedList(req, baseSql, countSql, params);
      return ok(res, result.items, result.meta);
    }),
  );

  router.post(
    "/admin/services",
    requirePermission("platform.edit"),
    asyncHandler(async (req, res) => {
      const payload = serviceCreateSchema.parse(req.body);
      const category = await queryOne<any>(`SELECT id FROM categories WHERE id = ?`, [payload.category_id]);
      if (!category) throw new ApiError(400, "CATEGORY_NOT_FOUND", "Categorie introuvable.");
      const serviceId = createId("svc");
      await execute(
        `INSERT INTO services (id, category_id, name, slug, description, image_url, marketing_title, price_label, base_publication_price_cents, status, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [serviceId, payload.category_id, payload.name, payload.slug, payload.description ?? null, payload.image_url ?? null, payload.marketing_title ?? null, payload.price_label ?? null, payload.base_publication_price_cents ?? null, payload.status, payload.sort_order],
      );
      return created(res, await queryOne(`SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = ?`, [serviceId]));
    }),
  );

  router.patch(
    "/admin/services/:id",
    requirePermission("platform.edit"),
    asyncHandler(async (req, res) => {
      const serviceId = String(req.params.id);
      const existing = await queryOne<any>(`SELECT * FROM services WHERE id = ?`, [serviceId]);
      if (!existing) throw new ApiError(404, "SERVICE_NOT_FOUND", "Service introuvable.");
      const payload = servicePatchSchema.parse(req.body);
      if (payload.category_id) {
        const category = await queryOne<any>(`SELECT id FROM categories WHERE id = ?`, [payload.category_id]);
        if (!category) throw new ApiError(400, "CATEGORY_NOT_FOUND", "Categorie introuvable.");
      }
      const updatePayload: Record<string, unknown> = {
        ...(payload.category_id !== undefined ? { category_id: payload.category_id } : {}),
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.image_url !== undefined ? { image_url: payload.image_url } : {}),
        ...(payload.marketing_title !== undefined ? { marketing_title: payload.marketing_title } : {}),
        ...(payload.price_label !== undefined ? { price_label: payload.price_label } : {}),
        ...(payload.base_publication_price_cents !== undefined ? { base_publication_price_cents: payload.base_publication_price_cents } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
        ...(payload.sort_order !== undefined ? { sort_order: payload.sort_order } : {}),
      };
      await applyPatch("services", serviceId, updatePayload);
      return ok(res, await queryOne(`SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = ?`, [serviceId]));
    }),
  );

  return router;
}
