import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../core/auth";
import { execute, hasColumn, queryOne } from "../core/db";
import { ApiError } from "../core/errors";
import { created, ok, asyncHandler } from "../core/http";
import { createId } from "../core/store";
import {
  findReferrerByCode,
  getOrCreateReferralCode,
  recordReferral,
} from "../services/referral";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  locale: z.string().default("fr-CA"),
  ref_code: z.string().max(12).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const googleAuthSchema = z.object({
  credential: z.string().min(1),
  locale: z.string().default("fr-CA"),
  ref_code: z.string().max(12).optional(),
});

const profilePatchSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  phone: z.string().min(8).optional(),
  locale: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
});

function tokenFor(userId: string) {
  return `token-${userId}`;
}

type GoogleTokenInfo = {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  family_name?: string;
  given_name?: string;
  iss?: string;
  name?: string;
  picture?: string;
  sub?: string;
};

async function verifyGoogleCredential(credential: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();

  if (!clientId || clientId === "change-me-google-client-id") {
    throw new ApiError(500, "GOOGLE_AUTH_NOT_CONFIGURED", "Google authentication is not configured");
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!response.ok) {
    throw new ApiError(401, "INVALID_GOOGLE_CREDENTIAL", "Google credential could not be verified");
  }

  const tokenInfo = (await response.json()) as GoogleTokenInfo;
  const issuer = tokenInfo.iss ?? "";
  const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === "true";

  if (tokenInfo.aud !== clientId) {
    throw new ApiError(401, "INVALID_GOOGLE_AUDIENCE", "Google credential audience mismatch");
  }

  if (!["accounts.google.com", "https://accounts.google.com"].includes(issuer)) {
    throw new ApiError(401, "INVALID_GOOGLE_ISSUER", "Google credential issuer mismatch");
  }

  if (!tokenInfo.sub || !tokenInfo.email || !emailVerified) {
    throw new ApiError(401, "INVALID_GOOGLE_PROFILE", "Google profile is incomplete or not verified");
  }

  return {
    email: tokenInfo.email,
    firstName: tokenInfo.given_name?.trim() || tokenInfo.name?.trim() || "Google",
    lastName: tokenInfo.family_name?.trim() || "",
    subjectId: tokenInfo.sub,
  };
}

export function authRouter() {
  const router = Router();

  router.post(
    "/auth/register",
    asyncHandler(async (req, res) => {
      const payload = registerSchema.parse(req.body);
      const existing = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = ?", [payload.email]);
      if (existing) {
        throw new ApiError(409, "EMAIL_ALREADY_EXISTS", "Email already exists");
      }

      const userId = createId("usr");
      await execute(
        `INSERT INTO users (
          id, email, password_hash, first_name, last_name, locale,
          is_client_enabled, is_provider_enabled, status
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'active')`,
        [userId, payload.email, payload.password, payload.first_name, payload.last_name, payload.locale],
      );
      await execute(
        `INSERT INTO notification_preferences (
          id, user_id, email_messages_enabled, email_quotes_enabled,
          email_billing_enabled, email_marketing_enabled, push_enabled
        ) VALUES (?, ?, 1, 1, 1, 0, 0)`,
        [createId("npref"), userId],
      );

      // Generate referral code + record referral if invited
      await getOrCreateReferralCode(userId);
      if (payload.ref_code) {
        const referrer = await findReferrerByCode(payload.ref_code);
        if (referrer && referrer.id !== userId) {
          await recordReferral(referrer.id, userId);
        }
      }

      return created(res, {
        access_token: tokenFor(userId),
        refresh_token: `refresh-${userId}`,
        expires: 3600,
      });
    }),
  );

  router.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const payload = loginSchema.parse(req.body);
      const user = await queryOne<{
        id: string;
        password_hash: string | null;
        auth_provider: "local" | "google";
        status: "active" | "suspended";
      }>(
        `SELECT id, password_hash, auth_provider, status
           FROM users
          WHERE email = ?`,
        [payload.email],
      );

      if (user?.auth_provider === "google" && !user.password_hash) {
        throw new ApiError(401, "GOOGLE_SIGN_IN_REQUIRED", "Use Google sign-in for this account");
      }

      if (!user || (user.password_hash ?? "") !== payload.password) {
        throw new ApiError(401, "UNAUTHENTICATED", "Invalid credentials");
      }

      if (user.status === "suspended") {
        throw new ApiError(403, "ACCOUNT_SUSPENDED", "Account is suspended");
      }

      return ok(res, {
        access_token: tokenFor(user.id),
        refresh_token: `refresh-${user.id}`,
        expires: 3600,
      });
    }),
  );

  router.post(
    "/auth/google",
    asyncHandler(async (req, res) => {
      const payload = googleAuthSchema.parse(req.body);
      const googleProfile = await verifyGoogleCredential(payload.credential);

      const existing = await queryOne<{
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        auth_provider: "local" | "google";
        google_subject_id: string | null;
        status: "active" | "suspended";
      }>(
        `SELECT id, email, first_name, last_name, auth_provider, google_subject_id, status
           FROM users
          WHERE google_subject_id = ?
             OR email = ?
          ORDER BY CASE WHEN google_subject_id = ? THEN 0 ELSE 1 END
          LIMIT 1`,
        [googleProfile.subjectId, googleProfile.email, googleProfile.subjectId],
      );

      if (existing?.status === "suspended") {
        throw new ApiError(403, "ACCOUNT_SUSPENDED", "Account is suspended");
      }

      if (existing) {
        await execute(
          `UPDATE users
              SET email = ?,
                  first_name = ?,
                  last_name = ?,
                  locale = ?,
                  auth_provider = 'google',
                  google_subject_id = ?,
                  email_verified_at = COALESCE(email_verified_at, NOW()),
                  last_login_at = NOW()
            WHERE id = ?`,
          [
            googleProfile.email,
            existing.first_name || googleProfile.firstName,
            existing.last_name || googleProfile.lastName,
            payload.locale,
            googleProfile.subjectId,
            existing.id,
          ],
        );

        return ok(res, {
          access_token: tokenFor(existing.id),
          refresh_token: `refresh-${existing.id}`,
          expires: 3600,
        });
      }

      const userId = createId("usr");
      await execute(
        `INSERT INTO users (
          id, email, password_hash, first_name, last_name, locale, auth_provider,
          google_subject_id, is_client_enabled, is_provider_enabled, status, email_verified_at, last_login_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'google', ?, 1, 0, 'active', NOW(), NOW())`,
        [userId, googleProfile.email, googleProfile.firstName, googleProfile.lastName, payload.locale, googleProfile.subjectId],
      );
      await execute(
        `INSERT INTO notification_preferences (
          id, user_id, email_messages_enabled, email_quotes_enabled,
          email_billing_enabled, email_marketing_enabled, push_enabled
        ) VALUES (?, ?, 1, 1, 1, 0, 0)`,
        [createId("npref"), userId],
      );

      // Generate referral code + record referral if invited
      await getOrCreateReferralCode(userId);
      if (payload.ref_code) {
        const referrer = await findReferrerByCode(payload.ref_code);
        if (referrer && referrer.id !== userId) {
          await recordReferral(referrer.id, userId);
        }
      }

      return created(res, {
        access_token: tokenFor(userId),
        refresh_token: `refresh-${userId}`,
        expires: 3600,
      });
    }),
  );

  router.post("/auth/refresh", (_req, res) =>
    ok(res, {
      access_token: "token-refresh-user",
      refresh_token: "refresh-rotated",
      expires: 3600,
    }),
  );

  router.post("/auth/logout", (_req, res) => ok(res, { success: true }));
  router.post("/auth/password/request", (_req, res) => ok(res, { success: true }));
  router.post("/auth/password/reset", (_req, res) => ok(res, { success: true }));

  router.get(
    "/users/me",
    authRequired,
    asyncHandler((_req, res) => ok(res, _req.user)),
  );

  router.patch(
    "/users/me",
    authRequired,
    asyncHandler(async (req, res) => {
      const payload = profilePatchSchema.parse(req.body);
      const hasAvatarUrl = await hasColumn("users", "avatar_url");
      const fields: string[] = [];
      const values: unknown[] = [];

      for (const [key, value] of Object.entries(payload)) {
        if (key === "avatar_url" && !hasAvatarUrl) continue;
        fields.push(`${key} = ?`);
        values.push(value);
      }

      if (fields.length > 0) {
        await execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...values, req.user!.id]);
      }

      const avatarSelect = hasAvatarUrl ? ", avatar_url" : "";
      const user = await queryOne(
        `SELECT id, email, first_name, last_name, phone, locale, email_verified_at,
                is_client_enabled, is_provider_enabled, status${avatarSelect}, created_at, updated_at
           FROM users
          WHERE id = ?`,
        [req.user!.id],
      );

      return ok(res, user);
    }),
  );

  return router;
}
