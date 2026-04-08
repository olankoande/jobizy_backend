/**
 * Automated email reminders:
 *  1. Quote unread for 48h → notify client to check their quotes
 *  2. Request published with quotes but no selection for 5 days → nudge client
 *  3. Request expiring in 24h (no selection, has quotes) → urgent nudge
 *
 * Runs on a setInterval — no external cron library needed.
 */

import { query } from "../core/db";
import { sendEventEmail } from "./email";

const INTERVAL_MS = 60 * 60 * 1000; // every hour

// ── helpers ────────────────────────────────────────────────────────────────

async function hasRecentReminder(userId: string, type: string, withinHours: number): Promise<boolean> {
  const rows = await query<any>(
    `SELECT id FROM notifications
      WHERE user_id = ?
        AND type = ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 1`,
    [userId, type, withinHours],
  );
  return rows.length > 0;
}

// ── job 1: unread quote 48h ─────────────────────────────────────────────────

async function remindClientsUnreadQuotes() {
  // Find quotes submitted ≥48h ago where the client hasn't read them (no conversation read, quote status still 'pending')
  // We approximate "unread" as: quote submitted 48h+ ago, request still published/in_discussion, no mission yet
  const rows = await query<any>(
    `SELECT DISTINCT r.client_user_id AS user_id, r.title AS request_title
       FROM quotes q
       JOIN requests r ON r.id = q.request_id
      WHERE q.status = 'pending'
        AND q.submitted_at <= DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND r.status IN ('published', 'in_discussion')
        AND NOT EXISTS (
          SELECT 1 FROM missions m WHERE m.request_id = r.id
        )`,
    [],
  );

  for (const row of rows) {
    const type = "reminder_unread_quote_48h";
    if (await hasRecentReminder(row.user_id, type, 48)) continue;

    await sendEventEmail({
      userId: row.user_id,
      type,
      title: "Des prestataires attendent votre reponse",
      body: `Vous avez recu des offres sur votre demande "${row.request_title}" il y a plus de 48h. Consultez-les avant qu'elles ne expirent.`,
    }).catch((err) => console.error("remindClientsUnreadQuotes error:", err));
  }
}

// ── job 2: 5 days no decision ──────────────────────────────────────────────

async function remindClientsNoDecision5Days() {
  // Request published ≥5 days ago, has quotes, no mission created
  const rows = await query<any>(
    `SELECT DISTINCT r.client_user_id AS user_id, r.title AS request_title
       FROM requests r
      WHERE r.status IN ('published', 'in_discussion')
        AND r.published_at <= DATE_SUB(NOW(), INTERVAL 5 DAY)
        AND EXISTS (
          SELECT 1 FROM quotes q WHERE q.request_id = r.id AND q.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM missions m WHERE m.request_id = r.id
        )`,
    [],
  );

  for (const row of rows) {
    const type = "reminder_no_decision_5d";
    if (await hasRecentReminder(row.user_id, type, 120)) continue; // don't re-send within 5 days

    await sendEventEmail({
      userId: row.user_id,
      type,
      title: "Votre demande attend votre decision depuis 5 jours",
      body: `Votre demande "${row.request_title}" a des offres en attente depuis plus de 5 jours. Choisissez un prestataire pour avancer.`,
    }).catch((err) => console.error("remindClientsNoDecision5Days error:", err));
  }
}

// ── job 3: expiring in 24h ─────────────────────────────────────────────────

async function remindClientsExpiringRequests() {
  // Requests whose desired_date is tomorrow (within next 24h), still published, has quotes, no mission
  const rows = await query<any>(
    `SELECT DISTINCT r.client_user_id AS user_id, r.title AS request_title
       FROM requests r
      WHERE r.status IN ('published', 'in_discussion')
        AND r.desired_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)
        AND EXISTS (
          SELECT 1 FROM quotes q WHERE q.request_id = r.id AND q.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM missions m WHERE m.request_id = r.id
        )`,
    [],
  );

  for (const row of rows) {
    const type = "reminder_expiring_24h";
    if (await hasRecentReminder(row.user_id, type, 24)) continue;

    await sendEventEmail({
      userId: row.user_id,
      type,
      title: "Votre demande expire bientot !",
      body: `La date prevue pour votre demande "${row.request_title}" arrive dans moins de 24h. Choisissez un prestataire maintenant pour ne pas rater votre creneau.`,
    }).catch((err) => console.error("remindClientsExpiringRequests error:", err));
  }
}

// ── main loop ──────────────────────────────────────────────────────────────

async function runAllReminders() {
  try {
    await remindClientsUnreadQuotes();
    await remindClientsNoDecision5Days();
    await remindClientsExpiringRequests();
  } catch (err) {
    console.error("Reminders job error:", err);
  }
}

export function startReminders() {
  // Run once on startup (with a 10s delay to allow DB connection to settle)
  setTimeout(() => {
    runAllReminders();
    setInterval(runAllReminders, INTERVAL_MS);
  }, 10_000);
}
