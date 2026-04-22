import { Router } from "express";
import { hasColumn, query, queryOne } from "../core/db";
import { ok } from "../core/http";

function parseLocales(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : ["fr-CA", "en-CA"];
    } catch {
      return ["fr-CA", "en-CA"];
    }
  }
  return ["fr-CA", "en-CA"];
}

export function catalogRouter() {
  const router = Router();

  router.get("/jobizy/platform-settings", async (_req, res) => {
    const [hasAutoExpiryDays, hasPaymentEnabled, hasPaymentPrice] = await Promise.all([
      hasColumn("platform_settings", "request_auto_expiry_days"),
      hasColumn("platform_settings", "request_publication_payment_enabled"),
      hasColumn("platform_settings", "default_request_publication_price_cents"),
    ]);
    const extraCols = [
      hasAutoExpiryDays ? ", request_auto_expiry_days" : "",
      hasPaymentEnabled ? ", request_publication_payment_enabled" : "",
      hasPaymentPrice ? ", default_request_publication_price_cents" : "",
    ].join("");
    const settings = await queryOne<any>(
      `SELECT currency, brand_logo_url, supported_locales, default_locale, pwa_push_enabled${extraCols}
         FROM platform_settings
        WHERE id = 1`,
    );

    return ok(res, {
      currency: settings?.currency ?? "CAD",
      brand_logo_url: settings?.brand_logo_url ?? null,
      supported_locales: parseLocales(settings?.supported_locales),
      default_locale: settings?.default_locale ?? "fr-CA",
      pwa_push_enabled: Number(settings?.pwa_push_enabled ?? 0) === 1,
      request_auto_expiry_days: Number(settings?.request_auto_expiry_days ?? 7),
      request_publication_payment_enabled: hasPaymentEnabled ? Number(settings?.request_publication_payment_enabled ?? 0) === 1 : false,
      default_request_publication_price_cents: hasPaymentPrice ? Number(settings?.default_request_publication_price_cents ?? 0) : 0,
    });
  });

  router.get("/categories", async (_req, res) => {
    const hasIcon = await hasColumn("categories", "icon");
    return ok(
      res,
      await query(
        `SELECT id, name, slug, description, image_url, ${hasIcon ? "icon" : "NULL AS icon"}, marketing_title, marketing_subtitle, status, sort_order
           FROM categories
          WHERE status = 'active'
          ORDER BY sort_order, name`,
      ),
    );
  });

  router.get("/services", async (req, res) => {
    const hasIndicativePriceLabel = await hasColumn("services", "indicative_price_label");
    const categoryId = req.query.category_id?.toString();
    const sql =
      `SELECT id, category_id, name, slug, description, image_url, marketing_title, price_label,
              ${hasIndicativePriceLabel ? "indicative_price_label" : "price_label AS indicative_price_label"}, status, base_publication_price_cents, sort_order
         FROM services
        WHERE status = 'active'` + (categoryId ? " AND category_id = ?" : "") + " ORDER BY sort_order, name";
    return ok(res, await query(sql, categoryId ? [categoryId] : []));
  });

  router.get(
    "/services/:id",
    async (req, res) => {
      const hasIndicativePriceLabel = await hasColumn("services", "indicative_price_label");
      return (
      ok(
        res,
        await queryOne(
          `SELECT id, category_id, name, slug, description, image_url, marketing_title, price_label,
                  ${hasIndicativePriceLabel ? "indicative_price_label" : "price_label AS indicative_price_label"}, status, base_publication_price_cents, sort_order
             FROM services
            WHERE id = ?`,
          [String(req.params.id)],
        ),
      ));
    },
  );

  router.get("/zones", async (req, res) => {
    const parentId = req.query.parent_id?.toString();
    const search = req.query.search?.toString().toLowerCase();
    let sql = `SELECT id, parent_id, type, name, code, image_url, marketing_blurb, status, latitude, longitude, sort_order
                 FROM zones
                WHERE status = 'active'`;
    const params: unknown[] = [];

    if (parentId) {
      sql += " AND parent_id = ?";
      params.push(parentId);
    }
    if (search) {
      sql += " AND LOWER(name) LIKE ?";
      params.push(`%${search}%`);
    }

    sql += " ORDER BY sort_order, name";
    return ok(res, await query(sql, params));
  });

  router.get("/jobizy/public-highlights", async (_req, res) => {
    const [providers, cities] = await Promise.all([
      query(
        `SELECT
            pp.id,
            pp.display_name,
            pp.business_name,
            pp.description,
            pp.logo_url,
            pp.cover_url,
            pp.rating_avg,
            pp.rating_count,
            pp.response_time_avg_minutes,
            pp.completed_missions_count,
            COALESCE((
              SELECT JSON_ARRAYAGG(service_name)
              FROM (
                SELECT DISTINCT s.name AS service_name, s.sort_order
                FROM provider_services ps
                JOIN services s ON s.id = ps.service_id
                WHERE ps.provider_profile_id = pp.id AND ps.status = 'active' AND s.status = 'active'
                ORDER BY s.sort_order ASC, s.name ASC
                LIMIT 3
              ) service_names
            ), JSON_ARRAY()) AS services,
            COALESCE((
              SELECT JSON_ARRAYAGG(zone_name)
              FROM (
                SELECT DISTINCT z.name AS zone_name, z.sort_order
                FROM provider_zones pz
                JOIN zones z ON z.id = pz.zone_id
                WHERE pz.provider_profile_id = pp.id AND z.status = 'active'
                ORDER BY z.sort_order ASC, z.name ASC
                LIMIT 3
              ) zone_names
            ), JSON_ARRAY()) AS zones
          FROM provider_profiles pp
          WHERE pp.is_profile_public = 1 AND pp.provider_status IN ('active', 'pending_review')
          ORDER BY pp.rating_avg DESC, pp.rating_count DESC, pp.completed_missions_count DESC
          LIMIT 6`,
      ),
      query(
        `SELECT
            z.id,
            z.name,
            z.image_url,
            z.marketing_blurb,
            COALESCE((
              SELECT COUNT(DISTINCT pz.provider_profile_id)
              FROM provider_zones pz
              JOIN provider_profiles pp ON pp.id = pz.provider_profile_id
              WHERE pz.zone_id = z.id AND pp.provider_status = 'active' AND pp.is_profile_public = 1
            ), 0) AS provider_count,
            COALESCE((
              SELECT JSON_ARRAYAGG(service_name)
              FROM (
                SELECT DISTINCT s.name AS service_name, s.sort_order
                FROM provider_zones pz
                JOIN provider_services ps ON ps.provider_profile_id = pz.provider_profile_id AND ps.status = 'active'
                JOIN services s ON s.id = ps.service_id AND s.status = 'active'
                JOIN provider_profiles pp ON pp.id = pz.provider_profile_id
                WHERE pz.zone_id = z.id AND pp.provider_status = 'active' AND pp.is_profile_public = 1
                ORDER BY s.sort_order ASC, s.name ASC
                LIMIT 3
              ) service_names
            ), JSON_ARRAY()) AS top_services
          FROM zones z
          WHERE z.status = 'active' AND z.type = 'city'
          ORDER BY provider_count DESC, z.sort_order ASC, z.name ASC
          LIMIT 6`,
      ),
    ]);

    const normalizeJsonArray = <T,>(value: unknown): T[] => {
      if (Array.isArray(value)) return value as T[];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    return ok(res, {
      providers: providers.map((item: any) => ({
        ...item,
        services: normalizeJsonArray<string>(item.services),
        zones: normalizeJsonArray<string>(item.zones),
      })),
      cities: cities.map((item: any) => ({
        ...item,
        top_services: normalizeJsonArray<string>(item.top_services),
      })),
    });
  });

  return router;
}
