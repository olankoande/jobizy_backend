import { PoolConnection } from "mysql2/promise";
import { execute } from "../core/db";
import { ApiError } from "../core/errors";
import { sendEventEmail } from "./email";
import { createId } from "../core/store";

export async function writeAuditLog(
  connection: PoolConnection | null,
  actorUserId: string | null,
  entityType: string,
  entityId: string | null,
  action: string,
  newValues: Record<string, unknown> | null,
  ipAddress?: string | null,
) {
  const sql = `INSERT INTO audit_logs
    (id, actor_user_id, entity_type, entity_id, action, old_values_json, new_values_json, ip_address)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`;
  const params = [
    createId("audit"),
    actorUserId,
    entityType,
    entityId,
    action,
    newValues !== null ? JSON.stringify(newValues) : null,
    ipAddress ?? null,
  ];

  if (connection) {
    await connection.execute(sql, params);
    return;
  }

  await execute(sql, params);
}

export type PublishableRequest = {
  id: string;
  client_user_id: string;
  service_id: string;
  zone_id: string;
  title: string;
  status: string;
  publication_payment_required: number | boolean;
};

function isPaymentRequired(value: number | boolean) {
  return value === true || value === 1;
}

export async function createInAppNotification(
  connection: PoolConnection | null,
  userId: string,
  type: string,
  title: string,
  body: string,
) {
  const sql = `INSERT INTO notifications (id, user_id, type, title, body, channel, is_read, sent_at)
               VALUES (?, ?, ?, ?, ?, 'in_app', 0, NOW())`;
  const params = [createId("notif"), userId, type, title, body];

  if (connection) {
    await connection.execute(sql, params);
    return;
  }

  await execute(sql, params);
}

export async function runMatchingForRequest(
  connection: PoolConnection,
  requestId: string,
  serviceId: string,
  zoneId: string,
  title: string,
) {
  const [providersRows] = await connection.query<any[]>(
    `SELECT DISTINCT pp.id, pp.user_id
       FROM provider_profiles pp
       JOIN provider_services ps
         ON ps.provider_profile_id = pp.id
        AND ps.service_id = ?
        AND ps.status = 'active'
       JOIN provider_zones pz
         ON pz.provider_profile_id = pp.id
        AND pz.zone_id = ?
      JOIN subscriptions s
         ON s.provider_profile_id = pp.id
        AND s.status IN ('trial', 'active')
      WHERE pp.provider_status = 'active'
        AND COALESCE(NULLIF(TRIM(pp.display_name), ''), NULL) IS NOT NULL
        AND COALESCE(NULLIF(TRIM(pp.business_name), ''), NULL) IS NOT NULL
        AND COALESCE(NULLIF(TRIM(pp.description), ''), NULL) IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM availabilities a
           WHERE a.provider_profile_id = pp.id
             AND a.is_active = 1
        )`,
    [serviceId, zoneId],
  );

  const providers = providersRows as Array<{ id: string; user_id: string }>;
  let count = 0;

  for (const provider of providers) {
    const [existingRows] = await connection.query<any[]>(
      `SELECT id FROM matches WHERE request_id = ? AND provider_profile_id = ?`,
      [requestId, provider.id],
    );

    if ((existingRows as any[]).length > 0) {
      continue;
    }

    await connection.execute(
      `INSERT INTO matches (
        id, request_id, provider_profile_id, match_score, match_reason,
        is_visible_to_provider, notified_at
      ) VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [createId("match"), requestId, provider.id, 90, JSON.stringify({ rule: "service_zone_subscription" })],
    );

    await createInAppNotification(connection, provider.user_id, "new_match", "Nouvelle demande disponible", title);
    void sendEventEmail({ userId: provider.user_id, type: "new_match", title: "Nouvelle demande disponible", body: title });
    count += 1;
  }

  return count;
}

export async function publishRequest(
  connection: PoolConnection,
  request: PublishableRequest,
) {
  if (request.status === "published") {
    return { matchesCreated: 0, alreadyPublished: true };
  }

  if (isPaymentRequired(request.publication_payment_required)) {
    // La liaison payment→request se fait via payments.related_entity_id = request.id,
    // pas via une colonne payment_id sur requests.
    const [paymentRows] = await connection.query<any[]>(
      `SELECT id FROM payments
        WHERE related_entity_type = 'request'
          AND related_entity_id = ?
          AND payment_type = 'request_publication'
          AND status = 'paid'
        LIMIT 1`,
      [request.id],
    );
    const payment = (paymentRows as any[])[0];

    if (!payment) {
      throw new ApiError(400, "REQUEST_PUBLICATION_PAYMENT_REQUIRED", "Payment must be confirmed before publishing");
    }
  }

  await connection.execute(
    `UPDATE requests
        SET status = 'published', published_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)
      WHERE id = ?`,
    [request.id],
  );

  const matchesCreated = await runMatchingForRequest(connection, request.id, request.service_id, request.zone_id, request.title);
  await createInAppNotification(connection, request.client_user_id, "request_published", "Demande publiee", request.title);
  void sendEventEmail({ userId: request.client_user_id, type: "request_published", title: "Demande publiee", body: request.title });

  return { matchesCreated, alreadyPublished: false };
}
