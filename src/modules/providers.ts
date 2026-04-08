import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../core/auth";
import { execute, hasTable, query, queryOne } from "../core/db";
import { ApiError } from "../core/errors";
import { asyncHandler, created, ok } from "../core/http";
import { Availability, createId, ProviderProfile } from "../core/store";

const optionalNullableUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().url().nullable().optional(),
);

const providerPatchSchema = z.object({
  display_name: z.string().min(1).optional(),
  business_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  logo_url: optionalNullableUrl,
  cover_url: optionalNullableUrl,
  is_profile_public: z.boolean().optional(),
});

const providerServiceSchema = z.object({
  service_id: z.string().min(1),
});

const providerZoneSchema = z.object({
  zone_id: z.string().min(1),
  coverage_type: z.enum(["standard", "priority"]).default("standard"),
});

const availabilityCreateSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  is_active: z.boolean().default(true),
});

const availabilityPatchSchema = availabilityCreateSchema.partial();

function ensureAvailabilityWindow(startTime: string, endTime: string) {
  if (startTime >= endTime) {
    throw new ApiError(400, "AVAILABILITY_INVALID_TIME_RANGE", "Availability start time must be before end time");
  }
}

async function getMyProviderProfile(userId: string): Promise<ProviderProfile> {
  const profile = await queryOne<ProviderProfile>(
    `SELECT id, user_id, display_name, business_name, description,
            logo_url, cover_url, verification_status, provider_status, rating_avg, rating_count,
            response_rate, response_time_avg_minutes, completed_missions_count, is_profile_public, created_at, updated_at
       FROM provider_profiles
      WHERE user_id = ?`,
    [userId],
  );
  if (!profile) {
    throw new ApiError(404, "PROVIDER_PROFILE_NOT_FOUND", "Provider profile not found");
  }
  return profile;
}

function validateProviderEditable(profile: ProviderProfile) {
  if (profile.provider_status === "suspended" || profile.provider_status === "rejected") {
    throw new ApiError(403, "PROVIDER_NOT_ELIGIBLE", "Provider profile is not editable in current state");
  }
}

export function providersRouter() {
  const router = Router();

  router.post(
    "/providers/activate",
    authRequired,
    asyncHandler(async (req, res) => {
      const user = req.user!;
      let profile = await queryOne<ProviderProfile>(
        `SELECT id, user_id, display_name, business_name, description,
                logo_url, cover_url, verification_status, provider_status, rating_avg, rating_count,
                response_rate, response_time_avg_minutes, completed_missions_count, is_profile_public, created_at, updated_at
           FROM provider_profiles
          WHERE user_id = ?`,
        [user.id],
      );

      if (!profile) {
        const profileId = createId("pp");
        await execute(
          `INSERT INTO provider_profiles (
            id, user_id, display_name, business_name, description,
            verification_status, provider_status, rating_avg, rating_count,
            completed_missions_count, is_profile_public
          ) VALUES (?, ?, ?, ?, ?, 'unverified', 'draft', 0, 0, 0, 0)`,
          [profileId, user.id, `${user.first_name} ${user.last_name}`.trim(), "", ""],
        );
        profile = await getMyProviderProfile(user.id);
      }

      await execute(`UPDATE users SET is_provider_enabled = 1 WHERE id = ?`, [user.id]);

      return ok(res, {
        provider_profile_id: profile.id,
        provider_status: profile.provider_status,
      });
    }),
  );

  router.get(
    "/provider-profiles/me",
    authRequired,
    asyncHandler(async (req, res) => ok(res, await getMyProviderProfile(req.user!.id))),
  );

  router.patch(
    "/provider-profiles/me",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      validateProviderEditable(profile);
      const payload = providerPatchSchema.parse(req.body);
      const fields: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(payload)) {
        fields.push(`${key} = ?`);
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
      if (fields.length > 0) {
        await execute(`UPDATE provider_profiles SET ${fields.join(", ")} WHERE id = ?`, [...values, profile.id]);
      }
      return ok(res, await getMyProviderProfile(req.user!.id));
    }),
  );

  router.get(
    "/provider-profiles/me/services",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const rows = await query<{ id: string; provider_profile_id: string; service_id: string; service_name: string; status: string; created_at: string }>(
        `SELECT ps.id, ps.provider_profile_id, ps.service_id, s.name AS service_name, ps.status, ps.created_at
           FROM provider_services ps
           JOIN services s ON s.id = ps.service_id
          WHERE ps.provider_profile_id = ?
          ORDER BY s.name`,
        [profile.id],
      );
      return ok(res, rows);
    }),
  );

  router.post(
    "/provider-profiles/me/services",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const payload = providerServiceSchema.parse(req.body);
      const service = await queryOne<{ id: string }>(`SELECT id FROM services WHERE id = ? AND status = 'active'`, [
        payload.service_id,
      ]);
      if (!service) {
        throw new ApiError(400, "SERVICE_INVALID", "Service must be active");
      }

      const exists = await queryOne<{ id: string }>(
        `SELECT id FROM provider_services WHERE provider_profile_id = ? AND service_id = ?`,
        [profile.id, payload.service_id],
      );
      if (exists) {
        throw new ApiError(409, "PROVIDER_SERVICE_EXISTS", "Service already linked");
      }

      const relation = {
        id: createId("psvc"),
        provider_profile_id: profile.id,
        service_id: payload.service_id,
        status: "active" as const,
        created_at: new Date().toISOString(),
      };
      await execute(
        `INSERT INTO provider_services (id, provider_profile_id, service_id, status)
         VALUES (?, ?, ?, 'active')`,
        [relation.id, relation.provider_profile_id, relation.service_id],
      );
      return created(res, relation);
    }),
  );

  router.delete(
    "/provider-profiles/me/services/:providerServiceId",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      validateProviderEditable(profile);
      const providerService = await queryOne<{ id: string }>(
        `SELECT id FROM provider_services WHERE id = ? AND provider_profile_id = ?`,
        [String(req.params.providerServiceId), profile.id],
      );
      if (!providerService) {
        throw new ApiError(404, "PROVIDER_SERVICE_NOT_FOUND", "Provider service not found");
      }
      await execute(`DELETE FROM provider_services WHERE id = ?`, [providerService.id]);
      return ok(res, { deleted: true });
    }),
  );

  router.get(
    "/provider-profiles/me/zones",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const rows = await query<{ id: string; provider_profile_id: string; zone_id: string; zone_name: string; coverage_type: string; created_at: string }>(
        `SELECT pz.id, pz.provider_profile_id, pz.zone_id, z.name AS zone_name, pz.coverage_type, pz.created_at
           FROM provider_zones pz
           JOIN zones z ON z.id = pz.zone_id
          WHERE pz.provider_profile_id = ?
          ORDER BY z.name`,
        [profile.id],
      );
      return ok(res, rows);
    }),
  );

  router.delete(
    "/provider-profiles/me/zones/:providerZoneId",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      validateProviderEditable(profile);
      const providerZone = await queryOne<{ id: string }>(
        `SELECT id FROM provider_zones WHERE id = ? AND provider_profile_id = ?`,
        [String(req.params.providerZoneId), profile.id],
      );
      if (!providerZone) {
        throw new ApiError(404, "PROVIDER_ZONE_NOT_FOUND", "Provider zone not found");
      }
      await execute(`DELETE FROM provider_zones WHERE id = ?`, [providerZone.id]);
      return ok(res, { deleted: true });
    }),
  );

  router.post(
    "/provider-profiles/me/zones",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const payload = providerZoneSchema.parse(req.body);
      const zone = await queryOne<{ id: string }>(`SELECT id FROM zones WHERE id = ? AND status = 'active'`, [
        payload.zone_id,
      ]);
      if (!zone) {
        throw new ApiError(400, "ZONE_INVALID", "Zone must be active");
      }

      const exists = await queryOne<{ id: string }>(
        `SELECT id FROM provider_zones WHERE provider_profile_id = ? AND zone_id = ?`,
        [profile.id, payload.zone_id],
      );
      if (exists) {
        throw new ApiError(409, "PROVIDER_ZONE_EXISTS", "Zone already linked");
      }

      const relation = {
        id: createId("pzone"),
        provider_profile_id: profile.id,
        zone_id: payload.zone_id,
        coverage_type: payload.coverage_type === "priority" ? "secondary" : "primary",
        created_at: new Date().toISOString(),
      };
      await execute(
        `INSERT INTO provider_zones (id, provider_profile_id, zone_id, coverage_type)
         VALUES (?, ?, ?, ?)`,
        [relation.id, relation.provider_profile_id, relation.zone_id, relation.coverage_type],
      );
      return created(res, relation);
    }),
  );

  router.get(
    "/provider-profiles/me/matching-requests",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const rows = await query<any>(
        `SELECT DISTINCT r.id, r.title, r.description, r.desired_date, r.urgency, r.status,
                r.budget_min_cents, r.budget_max_cents, r.work_mode,
                r.time_window_start, r.time_window_end, r.updated_at, r.created_at,
                r.service_id, s.name AS service_name, s.category_id,
                z.name AS zone_name, c.icon AS category_icon,
                CASE WHEN q.id IS NOT NULL THEN 1 ELSE 0 END AS already_quoted
           FROM requests r
           JOIN services s ON s.id = r.service_id
           JOIN categories c ON c.id = s.category_id
           JOIN zones z ON z.id = r.zone_id
           JOIN provider_services ps ON ps.service_id = r.service_id
             AND ps.provider_profile_id = ?
             AND ps.status = 'active'
           JOIN provider_zones pz ON pz.zone_id = r.zone_id
             AND pz.provider_profile_id = ?
           LEFT JOIN quotes q ON q.request_id = r.id
             AND q.provider_profile_id = ?
          WHERE r.status IN ('published', 'in_discussion')
            AND r.client_user_id != ?
            AND (
              r.desired_date IS NULL
              OR EXISTS (
                SELECT 1 FROM availabilities a
                 WHERE a.provider_profile_id = ?
                   AND a.is_active = 1
                   AND a.weekday = (DAYOFWEEK(r.desired_date) - 1)
              )
            )
          ORDER BY r.updated_at DESC`,
        [profile.id, profile.id, profile.id, req.user!.id, profile.id],
      );
      return ok(res, rows.map((row: any) => ({ ...row, already_quoted: Boolean(row.already_quoted) })));
    }),
  );

  router.get(
    "/provider-profiles/me/matching-debug",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);

      const [myServices, myZones, myAvailabilities] = await Promise.all([
        query<any>(
          `SELECT ps.service_id, s.name AS service_name, ps.status
             FROM provider_services ps
             JOIN services s ON s.id = ps.service_id
            WHERE ps.provider_profile_id = ?`,
          [profile.id],
        ),
        query<any>(
          `SELECT pz.zone_id, z.name AS zone_name
             FROM provider_zones pz
             JOIN zones z ON z.id = pz.zone_id
            WHERE pz.provider_profile_id = ?`,
          [profile.id],
        ),
        query<any>(
          `SELECT weekday, start_time, end_time, is_active
             FROM availabilities
            WHERE provider_profile_id = ?`,
          [profile.id],
        ),
      ]);

      const publishedRequests = await query<any>(
        `SELECT r.id, r.title, r.status, r.desired_date, r.client_user_id,
                r.service_id, s.name AS service_name,
                r.zone_id, z.name AS zone_name
           FROM requests r
           JOIN services s ON s.id = r.service_id
           JOIN zones z ON z.id = r.zone_id
          WHERE r.status IN ('published', 'in_discussion')
          ORDER BY r.updated_at DESC
          LIMIT 20`,
        [],
      );

      const myServiceIds = new Set(myServices.filter((s: any) => s.status === "active").map((s: any) => s.service_id));
      const myZoneIds = new Set(myZones.map((z: any) => z.zone_id));

      const analysis = publishedRequests.map((r: any) => ({
        id: r.id,
        title: r.title,
        service: r.service_name,
        zone: r.zone_name,
        desired_date: r.desired_date,
        is_same_user: r.client_user_id === req.user!.id,
        service_matches: myServiceIds.has(r.service_id),
        zone_matches: myZoneIds.has(r.zone_id),
      }));

      return ok(res, {
        provider_profile_id: profile.id,
        provider_user_id: req.user!.id,
        provider_status: profile.provider_status,
        my_services: myServices,
        my_zones: myZones,
        my_availabilities: myAvailabilities,
        published_requests_count: publishedRequests.length,
        published_requests: analysis,
      });
    }),
  );

  router.post(
    "/provider-profiles/me/activate",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);

      if (profile.provider_status === "suspended" || profile.provider_status === "rejected") {
        throw new ApiError(403, "PROVIDER_NOT_ELIGIBLE", "Ce profil ne peut pas être activé dans son état actuel.");
      }
      if (!profile.display_name?.trim() || !profile.business_name?.trim() || !profile.description?.trim()) {
        throw new ApiError(400, "PROVIDER_PROFILE_INCOMPLETE", "Nom public, nom d'entreprise et description sont requis.");
      }

      const [services, zones, availabilities] = await Promise.all([
        queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM provider_services WHERE provider_profile_id = ? AND status = 'active'`, [profile.id]),
        queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM provider_zones WHERE provider_profile_id = ?`, [profile.id]),
        queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM availabilities WHERE provider_profile_id = ? AND is_active = 1`, [profile.id]),
      ]);

      if (Number(services?.total ?? 0) === 0) {
        throw new ApiError(400, "PROVIDER_SERVICES_MISSING", "Ajoutez au moins un service pour activer votre profil.");
      }
      if (Number(zones?.total ?? 0) === 0) {
        throw new ApiError(400, "PROVIDER_ZONES_MISSING", "Ajoutez au moins une zone d'intervention.");
      }
      if (Number(availabilities?.total ?? 0) === 0) {
        throw new ApiError(400, "PROVIDER_AVAILABILITIES_MISSING", "Ajoutez au moins un créneau de disponibilité.");
      }

      await execute(
        `UPDATE provider_profiles SET provider_status = 'active', is_profile_public = 1, updated_at = NOW() WHERE id = ?`,
        [profile.id],
      );

      return ok(res, await getMyProviderProfile(req.user!.id));
    }),
  );

  router.get(
    "/provider-profiles/me/availabilities",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const rows = await query<Availability>(
        `SELECT id, provider_profile_id, weekday, start_time, end_time, is_active
           FROM availabilities
          WHERE provider_profile_id = ?
          ORDER BY weekday, start_time`,
        [profile.id],
      );
      return ok(res, rows);
    }),
  );

  router.post(
    "/provider-profiles/me/availabilities",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const payload = availabilityCreateSchema.parse(req.body);
      ensureAvailabilityWindow(payload.start_time, payload.end_time);

      const existingSlot = await queryOne<{ id: string }>(
        `SELECT id FROM availabilities WHERE provider_profile_id = ? AND weekday = ? AND is_active = 1`,
        [profile.id, payload.weekday],
      );
      if (existingSlot) {
        throw new ApiError(409, "AVAILABILITY_EXISTS", "Un créneau actif existe déjà pour ce jour.");
      }

      const availability: Availability = {
        id: createId("av"),
        provider_profile_id: profile.id,
        weekday: payload.weekday,
        start_time: payload.start_time,
        end_time: payload.end_time,
        is_active: payload.is_active,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await execute(
        `INSERT INTO availabilities (id, provider_profile_id, weekday, start_time, end_time, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          availability.id,
          availability.provider_profile_id,
          availability.weekday,
          availability.start_time,
          availability.end_time,
          availability.is_active ? 1 : 0,
        ],
      );
      return created(res, availability);
    }),
  );

  router.delete(
    "/availabilities/:id",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const availability = await queryOne<{ id: string }>(
        `SELECT id FROM availabilities WHERE id = ? AND provider_profile_id = ?`,
        [String(req.params.id), profile.id],
      );
      if (!availability) {
        throw new ApiError(404, "AVAILABILITY_NOT_FOUND", "Availability not found");
      }
      await execute(`DELETE FROM availabilities WHERE id = ?`, [availability.id]);
      return ok(res, { deleted: true });
    }),
  );

  router.patch(
    "/availabilities/:id",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await getMyProviderProfile(req.user!.id);
      const availability = await queryOne<Availability>(
        `SELECT id, provider_profile_id, weekday, start_time, end_time, is_active, created_at, updated_at
           FROM availabilities
          WHERE id = ? AND provider_profile_id = ?`,
        [String(req.params.id), profile.id],
      );
      if (!availability) {
        throw new ApiError(404, "AVAILABILITY_NOT_FOUND", "Availability not found");
      }

      const payload = availabilityPatchSchema.parse(req.body);
      ensureAvailabilityWindow(payload.start_time ?? availability.start_time, payload.end_time ?? availability.end_time);
      const fields: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(payload)) {
        fields.push(`${key} = ?`);
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
      if (fields.length > 0) {
        await execute(`UPDATE availabilities SET ${fields.join(", ")} WHERE id = ?`, [...values, availability.id]);
      }
      const updated = await queryOne(
        `SELECT id, provider_profile_id, weekday, start_time, end_time, is_active, created_at, updated_at
           FROM availabilities
          WHERE id = ?`,
        [availability.id],
      );
      return ok(res, updated);
    }),
  );

  // ── Portfolio ──────────────────────────────────────────────────────────────

  const portfolioItemSchema = z.object({
    title: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    image_url: z.string().url().nullable().optional(),
    sort_order: z.number().int().default(0),
  });

  router.get(
    "/provider-profiles/me/portfolio",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!profile) return ok(res, []);
      const items = await query<any>(`SELECT * FROM portfolio_items WHERE provider_profile_id = ? ORDER BY sort_order ASC, created_at ASC`, [profile.id]);
      return ok(res, items);
    }),
  );

  router.get(
    "/provider-profiles/:id/portfolio",
    asyncHandler(async (req, res) => {
      const items = await query<any>(
        `SELECT pi.* FROM portfolio_items pi
           JOIN provider_profiles pp ON pp.id = pi.provider_profile_id
          WHERE pp.id = ? AND pp.is_profile_public = 1
          ORDER BY pi.sort_order ASC, pi.created_at ASC`,
        [String(req.params.id)],
      );
      return ok(res, items);
    }),
  );

  router.post(
    "/provider-profiles/me/portfolio",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!profile) throw new ApiError(404, "PROFILE_NOT_FOUND", "Profil introuvable.");
      const payload = portfolioItemSchema.parse(req.body);
      const itemId = createId("pf");
      await execute(
        `INSERT INTO portfolio_items (id, provider_profile_id, title, description, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
        [itemId, profile.id, payload.title, payload.description ?? null, payload.image_url ?? null, payload.sort_order],
      );
      return created(res, await queryOne(`SELECT * FROM portfolio_items WHERE id = ?`, [itemId]));
    }),
  );

  router.patch(
    "/provider-profiles/me/portfolio/:id",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!profile) throw new ApiError(404, "PROFILE_NOT_FOUND", "Profil introuvable.");
      const item = await queryOne<any>(`SELECT id FROM portfolio_items WHERE id = ? AND provider_profile_id = ?`, [String(req.params.id), profile.id]);
      if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", "Item introuvable.");
      const payload = portfolioItemSchema.partial().parse(req.body);
      const entries = Object.entries(payload).filter(([, v]) => v !== undefined);
      if (entries.length > 0) {
        await execute(
          `UPDATE portfolio_items SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = NOW() WHERE id = ?`,
          [...entries.map(([, v]) => v), item.id],
        );
      }
      return ok(res, await queryOne(`SELECT * FROM portfolio_items WHERE id = ?`, [item.id]));
    }),
  );

  router.delete(
    "/provider-profiles/me/portfolio/:id",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!profile) throw new ApiError(404, "PROFILE_NOT_FOUND", "Profil introuvable.");
      const item = await queryOne<any>(`SELECT id FROM portfolio_items WHERE id = ? AND provider_profile_id = ?`, [String(req.params.id), profile.id]);
      if (!item) throw new ApiError(404, "ITEM_NOT_FOUND", "Item introuvable.");
      await execute(`DELETE FROM portfolio_items WHERE id = ?`, [item.id]);
      return ok(res, { deleted: true });
    }),
  );

  // ── Analytics ──────────────────────────────────────────────────────────────
  router.get(
    "/provider-profiles/me/analytics",
    authRequired,
    asyncHandler(async (req, res) => {
      const profile = await queryOne<any>(`SELECT id FROM provider_profiles WHERE user_id = ?`, [req.user!.id]);
      if (!profile) throw new ApiError(404, "PROFILE_NOT_FOUND", "Profil introuvable.");
      const pid = profile.id;

      const hasMatchesTable = await hasTable("request_matches");

      // Leads received (matches visible to provider)
      const leadsRow = hasMatchesTable
        ? await queryOne<any>(
            `SELECT COUNT(*) AS total FROM request_matches WHERE provider_profile_id = ? AND is_visible_to_provider = 1`,
            [pid],
          )
        : null;
      const leadsTotal = Number(leadsRow?.total ?? 0);

      // Quotes sent
      const quotesRow = await queryOne<any>(
        `SELECT COUNT(*) AS total FROM quotes WHERE provider_profile_id = ? AND status != 'withdrawn'`,
        [pid],
      );
      const quotesTotal = Number(quotesRow?.total ?? 0);

      // Quotes accepted (awarded)
      const acceptedRow = await queryOne<any>(
        `SELECT COUNT(*) AS total FROM quotes WHERE provider_profile_id = ? AND status = 'accepted'`,
        [pid],
      );
      const acceptedTotal = Number(acceptedRow?.total ?? 0);

      // Missions completed
      const missionsRow = await queryOne<any>(
        `SELECT COUNT(*) AS total FROM missions WHERE provider_profile_id = ? AND status = 'completed'`,
        [pid],
      );
      const missionsTotal = Number(missionsRow?.total ?? 0);

      // Revenue: sum of estimated_price_cents for accepted quotes linked to completed missions
      const revenueRow = await queryOne<any>(
        `SELECT COALESCE(SUM(q.estimated_price_cents), 0) AS total
         FROM missions m
         JOIN quotes q ON q.id = m.quote_id
         WHERE m.provider_profile_id = ? AND m.status = 'completed'`,
        [pid],
      );
      const revenueCents = Number(revenueRow?.total ?? 0);

      // Monthly leads — last 6 months
      const monthlyLeads = hasMatchesTable
        ? await query<any>(
            `SELECT DATE_FORMAT(rm.created_at, '%Y-%m') AS month, COUNT(*) AS leads
             FROM request_matches rm
             WHERE rm.provider_profile_id = ?
               AND rm.is_visible_to_provider = 1
               AND rm.created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
             GROUP BY month
             ORDER BY month ASC`,
            [pid],
          )
        : [];

      // Monthly revenue — last 6 months
      const monthlyRevenue = await query<any>(
        `SELECT DATE_FORMAT(m.completed_at, '%Y-%m') AS month, COALESCE(SUM(q.estimated_price_cents), 0) AS revenue_cents
         FROM missions m
         JOIN quotes q ON q.id = m.quote_id
         WHERE m.provider_profile_id = ?
           AND m.status = 'completed'
           AND m.completed_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
         GROUP BY month
         ORDER BY month ASC`,
        [pid],
      );

      const responseRate = leadsTotal > 0 ? Math.round((quotesTotal / leadsTotal) * 100) : null;
      const conversionRate = quotesTotal > 0 ? Math.round((acceptedTotal / quotesTotal) * 100) : null;

      return ok(res, {
        leads_total: leadsTotal,
        quotes_total: quotesTotal,
        accepted_total: acceptedTotal,
        missions_completed: missionsTotal,
        response_rate: responseRate,
        conversion_rate: conversionRate,
        revenue_cents: revenueCents,
        monthly_leads: monthlyLeads,
        monthly_revenue: monthlyRevenue,
      });
    }),
  );

  return router;
}
