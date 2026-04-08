import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { PoolConnection } from "mysql2/promise";
import nodemailer, { Transporter } from "nodemailer";
import { ApiError } from "../core/errors";
import { execute, queryOne } from "../core/db";
import { createId } from "../core/store";

type EmailCategory = "billing" | "quotes" | "messages" | "always";

type EventEmailPayload = {
  userId: string;
  type: string;
  title: string;
  body: string;
  connection?: PoolConnection | null;
  attachments?: Array<{
    filename: string;
    path?: string;
    url?: string;
    content?: Buffer;
    contentType?: string;
  }>;
};

type UserWithPreferences = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  email_billing_enabled: number | null;
  email_quotes_enabled: number | null;
  email_messages_enabled: number | null;
};

let transporter: Transporter | null = null;
let transportUnavailableLogged = false;

function isTruthyDbBoolean(value: number | null) {
  return value === 1;
}

function isConfigured(value?: string) {
  return !!value && !value.includes("change-me");
}

function getEmailProvider() {
  return (process.env.EMAIL_PROVIDER ?? process.env.MAIL_PROVIDER ?? "smtp").toLowerCase();
}

async function sendViaSenderApi(input: {
  toEmail: string;
  toName: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EventEmailPayload["attachments"];
}) {
  const apiKey = process.env.SENDER_API_KEY;
  const fromEmail = process.env.EMAIL_FROM ?? process.env.MAIL_FROM_EMAIL ?? "no-reply@jobizy.local";
  const fromName = process.env.MAIL_FROM_NAME ?? "Jobizy";

  if (!isConfigured(apiKey)) {
    throw new ApiError(500, "SENDER_NOT_CONFIGURED", "Sender API key is not configured");
  }

  const attachmentEntries =
    input.attachments
      ?.filter((attachment) => attachment.url)
      .map((attachment) => [attachment.filename, attachment.url as string]) ?? [];

  const attachments = Object.fromEntries(attachmentEntries);

  const response = await fetch("https://api.sender.net/v2/message/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: {
        email: fromEmail,
        name: fromName,
      },
      to: {
        email: input.toEmail,
        name: input.toName,
      },
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(attachmentEntries.length > 0 ? { attachments } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(502, "SENDER_API_ERROR", `Sender API error: ${errorText}`);
  }

  return true;
}

async function sendViaResendApi(input: {
  toEmail: string;
  toName: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EventEmailPayload["attachments"];
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM ?? process.env.MAIL_FROM_EMAIL ?? "no-reply@jobizy.local";
  const fromName = process.env.MAIL_FROM_NAME ?? "Jobizy";

  if (!isConfigured(apiKey)) {
    throw new ApiError(500, "RESEND_NOT_CONFIGURED", "Resend API key is not configured");
  }

  const attachments =
    input.attachments && input.attachments.length > 0
      ? await Promise.all(
          input.attachments.map(async (attachment) => {
            if (attachment.content) {
              return {
                filename: attachment.filename,
                content: attachment.content.toString("base64"),
              };
            }

            if (attachment.path) {
              const fileBuffer = await fsp.readFile(attachment.path);
              return {
                filename: attachment.filename,
                content: fileBuffer.toString("base64"),
              };
            }

            const fallbackPath = path.resolve(process.cwd(), "storage", "invoices", attachment.filename);
            if (fs.existsSync(fallbackPath)) {
              const fileBuffer = await fsp.readFile(fallbackPath);
              return {
                filename: attachment.filename,
                content: fileBuffer.toString("base64"),
              };
            }

            return null;
          }),
        ).then((items) => items.filter((item): item is { filename: string; content: string } => item !== null))
      : [];

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [`${input.toName} <${input.toEmail}>`],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ApiError(502, "RESEND_API_ERROR", `Resend API error: ${errorText}`);
  }

  return true;
}

function resolveEmailCategory(type: string): EmailCategory {
  switch (type) {
    // Mandatory financial notifications — never suppressed by preferences
    case "subscription_renewed":
    case "invoice_available":
    case "request_publication_payment_succeeded":
    case "request_publication_payment_failed":
      return "always";
    case "subscription_created":
    case "subscription_past_due":
    case "subscription_cancelled":
    case "subscription_expired":
      return "billing";
    case "request_cancelled":
    case "mission_cancelled":
    case "mission_confirmed":
    case "quote_withdrawn":
    case "quote_received":
    case "new_quote":
    case "new_quote_received":
    case "new_match":
    case "new_match_for_provider":
    case "request_matched":
    case "quote_rejected":
    case "quote_accepted":
    case "reminder_unread_quote_48h":
    case "reminder_no_decision_5d":
    case "reminder_expiring_24h":
      return "quotes";
    case "new_message":
    case "new_message_received":
      return "messages";
    case "subscription_updated":
      return "billing";
    default:
      return "always";
  }
}

async function recentlySentSameEmail(
  userId: string,
  type: string,
  connection?: PoolConnection | null,
) {
  const sql = `SELECT id
                 FROM notifications
                WHERE user_id = ?
                  AND type = ?
                  AND channel = 'email'
                  AND created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
                LIMIT 1`;

  if (connection) {
    const [rows] = await connection.query<any[]>(sql, [userId, type]);
    return ((rows as any[])[0] ?? null) !== null;
  }

  return (await queryOne(sql, [userId, type])) !== null;
}

async function recordEmailNotification(
  userId: string,
  type: string,
  title: string,
  body: string,
  connection?: PoolConnection | null,
) {
  const sql = `INSERT INTO notifications (id, user_id, type, title, body, channel, is_read, sent_at)
               VALUES (?, ?, ?, ?, ?, 'email', 1, NOW())`;
  const params = [createId("notif"), userId, type, title, body];

  if (connection) {
    await connection.execute(sql, params);
    return;
  }

  await execute(sql, params);
}

async function loadUserWithPreferences(userId: string, connection?: PoolConnection | null) {
  const sql = `SELECT u.id, u.email, u.first_name, u.last_name,
                      np.email_billing_enabled, np.email_quotes_enabled, np.email_messages_enabled
                 FROM users u
            LEFT JOIN notification_preferences np
                   ON np.user_id = u.id
                WHERE u.id = ?`;

  if (connection) {
    const [rows] = await connection.query<any[]>(sql, [userId]);
    return ((rows as any[])[0] ?? null) as UserWithPreferences | null;
  }

  return queryOne<UserWithPreferences>(sql, [userId]);
}

function canSendEmailForCategory(user: UserWithPreferences, category: EmailCategory) {
  switch (category) {
    case "billing":
      return user.email_billing_enabled == null || isTruthyDbBoolean(user.email_billing_enabled);
    case "quotes":
      return user.email_quotes_enabled == null || isTruthyDbBoolean(user.email_quotes_enabled);
    case "messages":
      return user.email_messages_enabled == null || isTruthyDbBoolean(user.email_messages_enabled);
    case "always":
    default:
      return true;
  }
}

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  const provider = getEmailProvider();

  if (provider === "sender") {
    return null;
  }

  if (provider !== "smtp") {
    return null;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = (process.env.SMTP_SECURE ?? "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!isConfigured(host)) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: isConfigured(user) ? { user, pass } : undefined,
  });

  return transporter;
}

function formatRecipientName(user: UserWithPreferences) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.email;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nl2br(value: string) {
  return escapeHtml(value).replaceAll("\n", "<br />");
}

function buildEmailHtml(input: {
  eyebrow: string;
  title: string;
  lead: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  accent: string;
  statusLabel?: string;
  footerNote?: string;
}) {
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:0;background:#f4efe7;font-family:Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4efe7;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fffdf9;border-radius:24px;overflow:hidden;border:1px solid #eadfce;">
            <tr>
              <td style="padding:32px 32px 20px;background:linear-gradient(135deg, ${input.accent} 0%, #1f2937 100%);color:#ffffff;">
                <div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;opacity:0.88;margin-bottom:12px;">${escapeHtml(input.eyebrow)}</div>
                <div style="font-size:30px;line-height:1.2;font-weight:700;margin-bottom:12px;">${escapeHtml(input.title)}</div>
                <div style="font-size:15px;line-height:1.7;max-width:480px;">${escapeHtml(input.lead)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 12px;">
                ${
                  input.statusLabel
                    ? `<div style="display:inline-block;padding:8px 14px;border-radius:999px;background:#f3efe6;color:#7c5a28;font-size:12px;font-weight:700;letter-spacing:0.3px;margin-bottom:18px;">${escapeHtml(input.statusLabel)}</div>`
                    : ""
                }
                <div style="font-size:16px;line-height:1.8;color:#374151;">${nl2br(input.body)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 8px;">
                <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:${input.accent};color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:700;font-size:14px;">${escapeHtml(input.ctaLabel)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px;font-size:13px;line-height:1.7;color:#6b7280;">
                <div style="padding-top:18px;border-top:1px solid #eee3d2;">${escapeHtml(input.footerNote ?? "Merci de faire confiance a Jobizy.")}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildEmailContent(type: string, user: UserWithPreferences, title: string, body: string) {
  const recipient = formatRecipientName(user);
  const appBaseUrl = process.env.FRONTEND_URL ?? process.env.APP_BASE_URL ?? "http://localhost:5173";

  switch (type) {
    case "request_publication_payment_succeeded":
      return {
        subject: "Paiement confirme pour votre demande Jobizy",
        text: `Bonjour ${recipient},\n\nLe paiement de publication de votre demande a bien ete confirme.\n\n${body}\n\nVous pouvez suivre votre demande ici : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Confirmation de paiement",
          title: "Votre demande est prete a avancer",
          lead: `Bonjour ${recipient}, le paiement de publication a bien ete confirme.`,
          body: `${body}\n\nVotre demande va maintenant pouvoir suivre son parcours normal sur Jobizy.`,
          ctaLabel: "Voir ma demande",
          ctaUrl: appBaseUrl,
          accent: "#b45309",
          statusLabel: "Paiement confirme",
        }),
      };
    case "request_publication_payment_failed":
      return {
        subject: "Echec du paiement de publication Jobizy",
        text: `Bonjour ${recipient},\n\nLe paiement de publication de votre demande a echoue.\n\n${body}\n\nVous pouvez reessayer depuis votre espace Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
      };
    case "subscription_created":
      return {
        subject: "Confirmation de votre abonnement Jobizy",
        text: `Bonjour ${recipient},\n\nVotre abonnement Jobizy est maintenant actif.\n\n${body}\n\nVous pouvez suivre votre abonnement ici : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Abonnement active",
          title: "Bienvenue dans votre nouvel abonnement",
          lead: `Bonjour ${recipient}, votre abonnement Jobizy est maintenant actif.`,
          body: `${body}\n\nVotre espace est pret et votre formule est bien prise en compte.`,
          ctaLabel: "Ouvrir mon abonnement",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Abonnement actif",
        }),
      };
    case "subscription_renewed":
      return {
        subject: "Renouvellement de votre abonnement Jobizy",
        text: `Bonjour ${recipient},\n\nLe paiement de renouvellement de votre abonnement a bien ete confirme.\n\n${body}\n\nVous pouvez suivre votre abonnement ici : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Renouvellement confirme",
          title: "Votre formule continue sans interruption",
          lead: `Bonjour ${recipient}, le renouvellement de votre abonnement a bien ete confirme.`,
          body: `${body}\n\nVotre acces reste actif et votre espace continue de fonctionner normalement.`,
          ctaLabel: "Consulter mon abonnement",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Renouvellement valide",
        }),
      };
    case "invoice_available":
      return {
        subject: "Votre recu Jobizy est disponible",
        text: `Bonjour ${recipient},\n\n${body}\n\nVous pouvez aussi retrouver vos factures dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Facture disponible",
          title: "Votre recu est pret",
          lead: `Bonjour ${recipient}, votre justificatif de paiement est disponible.`,
          body: `${body}\n\nLe PDF est joint a cet email lorsque disponible, et reste aussi accessible depuis votre espace Jobizy.`,
          ctaLabel: "Voir mes factures",
          ctaUrl: appBaseUrl,
          accent: "#1d4ed8",
          statusLabel: "Recu joint",
        }),
      };
    case "quote_received":
    case "new_quote":
    case "new_quote_received":
      return {
        subject: "Nouvelle offre recue sur votre demande",
        text: `Bonjour ${recipient},\n\nVous avez recu une nouvelle offre sur votre demande "${body}".\n\nConnectez-vous a Jobizy pour la consulter et choisir votre prestataire : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Nouvelle offre",
          title: "Un prestataire vous a envoye une offre",
          lead: `Bonjour ${recipient}, vous avez recu une nouvelle offre sur votre demande.`,
          body: `Un prestataire a repondu a votre demande "${body}".\n\nConnectez-vous pour consulter l'offre et choisir votre prestataire.`,
          ctaLabel: "Voir l'offre",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Nouvelle offre",
        }),
      };
    case "quote_rejected":
      return {
        subject: "Votre offre n'a pas ete retenue",
        text: `Bonjour ${recipient},\n\nVotre offre sur la demande "${body}" n'a pas ete retenue par le client.\n\nD'autres opportunites vous attendent sur Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Offre non retenue",
          title: "Le client a choisi un autre prestataire",
          lead: `Bonjour ${recipient}, votre offre n'a pas ete selectionnee cette fois.`,
          body: `Votre offre sur la demande "${body}" n'a pas ete retenue.\n\nNe vous decouragez pas — de nouvelles demandes correspondant a votre profil sont disponibles.`,
          ctaLabel: "Voir mes opportunites",
          ctaUrl: appBaseUrl,
          accent: "#6b7280",
          statusLabel: "Offre non retenue",
        }),
      };
    case "mission_confirmed":
      return {
        subject: "Felicitations ! Vous avez obtenu une mission",
        text: `Bonjour ${recipient},\n\nVotre offre a ete acceptee pour la mission "${body}".\n\nRetrouvez le detail de votre mission dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Mission confirmee",
          title: "Votre offre a ete acceptee !",
          lead: `Bonjour ${recipient}, felicitations — le client a choisi votre offre.`,
          body: `Vous avez obtenu la mission "${body}".\n\nRendez-vous dans votre espace Jobizy pour consulter les details et coordonner avec votre client.`,
          ctaLabel: "Voir ma mission",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Mission confirmee",
        }),
      };
    case "new_message":
    case "new_message_received":
      return {
        subject: "Vous avez recu un nouveau message sur Jobizy",
        text: `Bonjour ${recipient},\n\nVous avez recu un nouveau message.\n\nConnectez-vous pour repondre : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Nouveau message",
          title: "Vous avez un message",
          lead: `Bonjour ${recipient}, quelqu'un vous a envoye un message sur Jobizy.`,
          body: `Connectez-vous pour lire et repondre au message.`,
          ctaLabel: "Voir le message",
          ctaUrl: appBaseUrl,
          accent: "#1d4ed8",
          statusLabel: "Message non lu",
        }),
      };
    case "new_match":
    case "new_match_for_provider":
    case "request_matched":
      return {
        subject: "Nouvelle demande disponible pour vous sur Jobizy",
        text: `Bonjour ${recipient},\n\nUne nouvelle demande correspond a votre profil : "${body}".\n\nConsultez-la et envoyez votre offre dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Nouvelle opportunite",
          title: "Une demande correspond a votre profil",
          lead: `Bonjour ${recipient}, une nouvelle demande est disponible pour vous.`,
          body: `La demande "${body}" correspond a vos competences et votre zone d'intervention.\n\nSoyez parmi les premiers a envoyer votre offre !`,
          ctaLabel: "Voir la demande",
          ctaUrl: appBaseUrl,
          accent: "#b45309",
          statusLabel: "Nouvelle demande",
        }),
      };
    case "subscription_updated":
      return {
        subject: "Votre abonnement Jobizy est actif",
        text: `Bonjour ${recipient},\n\nVotre abonnement "${body}" est maintenant actif.\n\nAccedez a votre espace prestataire : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Abonnement active",
          title: "Votre abonnement est actif",
          lead: `Bonjour ${recipient}, votre abonnement Jobizy est bien pris en compte.`,
          body: `Votre formule "${body}" est maintenant active.\n\nVous pouvez recevoir des demandes et envoyer des offres depuis votre espace prestataire.`,
          ctaLabel: "Acceder a mon espace",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Abonnement actif",
        }),
      };
    case "dispute_opened":
      return {
        subject: "Un litige a ete ouvert sur Jobizy",
        text: `Bonjour ${recipient},\n\nUn litige a ete ouvert concernant : ${body}.\n\nNotre equipe va examiner la situation. Retrouvez le detail dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Litige ouvert",
          title: "Un litige a ete signale",
          lead: `Bonjour ${recipient}, un litige a ete ouvert sur une mission vous concernant.`,
          body: `Categorie du litige : ${body}.\n\nNotre equipe va examiner la situation et vous contactera si necessaire. Vous pouvez suivre l'avancement dans votre espace Jobizy.`,
          ctaLabel: "Voir le litige",
          ctaUrl: appBaseUrl,
          accent: "#dc2626",
          statusLabel: "Litige en cours",
        }),
      };
    case "request_published":
      return {
        subject: "Votre demande est publiee sur Jobizy",
        text: `Bonjour ${recipient},\n\nVotre demande "${body}" a bien ete publiee. Les prestataires vont pouvoir vous envoyer des offres.\n\nSuivez votre demande ici : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Demande publiee",
          title: "Votre demande est en ligne",
          lead: `Bonjour ${recipient}, votre demande a bien ete publiee.`,
          body: `Votre demande "${body}" est maintenant visible par les prestataires.\n\nVous recevrez une notification des qu'un prestataire vous envoie une offre.`,
          ctaLabel: "Suivre ma demande",
          ctaUrl: appBaseUrl,
          accent: "#0f766e",
          statusLabel: "Publiee",
        }),
      };
    case "reminder_unread_quote_48h":
      return {
        subject: "Des prestataires attendent votre reponse sur Jobizy",
        text: `Bonjour ${recipient},\n\n${body}\n\nConnectez-vous pour consulter les offres : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Rappel",
          title: "Des prestataires attendent votre reponse",
          lead: `Bonjour ${recipient}, vous avez des offres non consultees sur votre demande.`,
          body: `${body}\n\nConnectez-vous pour comparer les offres et choisir le prestataire qui vous convient.`,
          ctaLabel: "Voir les offres",
          ctaUrl: appBaseUrl,
          accent: "#b45309",
          statusLabel: "Offres en attente",
        }),
      };
    case "reminder_no_decision_5d":
      return {
        subject: "Votre demande attend votre decision depuis 5 jours",
        text: `Bonjour ${recipient},\n\n${body}\n\nConnectez-vous pour choisir un prestataire : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Rappel",
          title: "Choisissez votre prestataire",
          lead: `Bonjour ${recipient}, votre demande attend une decision depuis plusieurs jours.`,
          body: `${body}\n\nVos prestataires attendent votre reponse. Connectez-vous pour faire votre choix.`,
          ctaLabel: "Voir ma demande",
          ctaUrl: appBaseUrl,
          accent: "#b45309",
          statusLabel: "Decision en attente",
        }),
      };
    case "reminder_expiring_24h":
      return {
        subject: "Urgent : votre demande expire dans 24h",
        text: `Bonjour ${recipient},\n\n${body}\n\nConnectez-vous pour choisir un prestataire maintenant : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Rappel urgent",
          title: "Votre demande expire bientot !",
          lead: `Bonjour ${recipient}, la date de votre demande approche et des prestataires sont disponibles.`,
          body: `${body}\n\nNe manquez pas votre creneau — choisissez votre prestataire maintenant.`,
          ctaLabel: "Choisir maintenant",
          ctaUrl: appBaseUrl,
          accent: "#dc2626",
          statusLabel: "Urgent — moins de 24h",
        }),
      };
    case "request_cancelled":
      return {
        subject: "Une demande a laquelle vous avez repondu a ete annulee",
        text: `Bonjour ${recipient},\n\n${body}\n\nConsultez vos opportunites dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Demande annulee",
          title: "Une demande a ete annulee",
          lead: `Bonjour ${recipient}, la demande pour laquelle vous aviez soumis une offre vient d'etre annulee par le client.`,
          body: `${body}\n\nVotre offre a ete automatiquement archivee. Vous pouvez consulter les autres opportunites disponibles sur Jobizy.`,
          ctaLabel: "Voir mes opportunites",
          ctaUrl: appBaseUrl,
          accent: "#6b7280",
          statusLabel: "Demande annulee",
        }),
      };
    case "mission_cancelled":
      return {
        subject: "Votre mission a ete annulee",
        text: `Bonjour ${recipient},\n\n${body}\n\nConsultez vos missions dans Jobizy : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Mission annulee",
          title: "La mission a ete annulee",
          lead: `Bonjour ${recipient}, une mission qui vous concernait a ete annulee.`,
          body: `${body}\n\nSi vous avez des questions ou un litige a signaler, vous pouvez contacter le support depuis votre espace Jobizy.`,
          ctaLabel: "Voir mes missions",
          ctaUrl: appBaseUrl,
          accent: "#dc2626",
          statusLabel: "Mission annulee",
        }),
      };
    case "subscription_cancelled":
      return {
        subject: "Votre abonnement Jobizy a ete annule",
        text: `Bonjour ${recipient},\n\n${body}\n\nGerez votre abonnement ici : ${appBaseUrl}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Abonnement annule",
          title: "Votre abonnement est en cours d'annulation",
          lead: `Bonjour ${recipient}, votre abonnement Jobizy a ete mis en annulation.`,
          body: `${body}\n\nVous pouvez souscrire a un nouvel abonnement a tout moment depuis votre espace prestataire.`,
          ctaLabel: "Gerer mon abonnement",
          ctaUrl: appBaseUrl,
          accent: "#b45309",
          statusLabel: "Abonnement annule",
        }),
      };
    default:
      return {
        subject: title,
        text: `Bonjour ${recipient},\n\n${body}\n\nL'equipe Jobizy`,
        html: buildEmailHtml({
          eyebrow: "Notification Jobizy",
          title,
          lead: `Bonjour ${recipient},`,
          body,
          ctaLabel: "Ouvrir Jobizy",
          ctaUrl: appBaseUrl,
          accent: "#6b7280",
        }),
      };
  }
}

export async function sendEventEmail({ userId, type, title, body, connection, attachments }: EventEmailPayload) {
  const user = await loadUserWithPreferences(userId, connection);
  if (!user?.email) {
    return false;
  }

  const category = resolveEmailCategory(type);
  if (!canSendEmailForCategory(user, category)) {
    return false;
  }
  if (category === "messages" && (await recentlySentSameEmail(userId, type, connection))) {
    return false;
  }

  const fromEmail = process.env.EMAIL_FROM ?? process.env.MAIL_FROM_EMAIL ?? "no-reply@jobizy.local";
  const fromName = process.env.MAIL_FROM_NAME ?? "Jobizy";
  const content = buildEmailContent(type, user, title, body);
  const provider = getEmailProvider();

  try {
    if (provider === "sender") {
      const attachmentsWithUrls = attachments?.filter((attachment) => attachment.url);

      if (attachments && attachments.length > 0 && (!attachmentsWithUrls || attachmentsWithUrls.length !== attachments.length) && !transportUnavailableLogged) {
        console.warn("Sender attachments require public HTTPS URLs. Some attachments were skipped.");
        transportUnavailableLogged = true;
      }

      await sendViaSenderApi({
        toEmail: user.email,
        toName: formatRecipientName(user),
        subject: content.subject,
        text: content.text,
        html: content.html,
        attachments: attachmentsWithUrls,
      });
      await recordEmailNotification(userId, type, title, body, connection);

      return true;
    }

    if (provider === "resend") {
      await sendViaResendApi({
        toEmail: user.email,
        toName: formatRecipientName(user),
        subject: content.subject,
        text: content.text,
        html: content.html,
        attachments,
      });
      await recordEmailNotification(userId, type, title, body, connection);

      return true;
    }

    const transport = getTransporter();
    if (!transport) {
      if (!transportUnavailableLogged) {
        console.warn(`Email transport is not configured for provider "${provider}". Skipping outgoing emails.`);
        transportUnavailableLogged = true;
      }
      return false;
    }

    await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: user.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments,
    });
    await recordEmailNotification(userId, type, title, body, connection);

    return true;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`Email delivery failed via ${provider} for ${user.email}: ${details}`);
    return false;
  }
}
