import webpush from "web-push";
import { execute, query, queryOne } from "../core/db";
import { createId } from "../core/store";

let initialized = false;

function initVapid() {
  if (initialized) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();

  if (!publicKey || !privateKey) {
    return;
  }

  const subject =
    process.env.VAPID_SUBJECT?.trim() ??
    `mailto:${process.env.ADMIN_EMAILS?.split(",")[0]?.trim() ?? "admin@jobizy.local"}`;

  webpush.setVapidDetails(subject, publicKey, privateKey);
  initialized = true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() ?? null;
}

export async function ensurePushSubscriptionsTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

export async function upsertPushSubscription(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
) {
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
    [userId, endpoint],
  );

  if (existing) {
    await execute(
      "UPDATE push_subscriptions SET p256dh = ?, auth = ?, updated_at = NOW() WHERE id = ?",
      [p256dh, auth, existing.id],
    );
  } else {
    await execute(
      "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)",
      [createId("push"), userId, endpoint, p256dh, auth],
    );
  }
}

export async function removeUserPushSubscription(userId: string, endpoint: string) {
  await execute(
    "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
    [userId, endpoint],
  );
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string },
) {
  initVapid();
  if (!initialized) return;

  const subscriptions = await query<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
    [userId],
  );

  if (subscriptions.length === 0) return;

  const staleIds: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err: any) {
        // 410 Gone / 404 Not Found = subscription no longer valid
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          staleIds.push(sub.id);
        }
      }
    }),
  );

  if (staleIds.length > 0) {
    await execute(
      `DELETE FROM push_subscriptions WHERE id IN (${staleIds.map(() => "?").join(",")})`,
      staleIds,
    );
  }
}
