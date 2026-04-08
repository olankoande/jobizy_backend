import { execute, hasColumn, query, queryOne } from "../core/db";
import { createId } from "../core/store";

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1 to avoid confusion

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

export async function ensureReferralSchema() {
  const hasRefCode = await hasColumn("users", "referral_code");
  if (!hasRefCode) {
    await execute("ALTER TABLE users ADD COLUMN referral_code VARCHAR(12) NULL UNIQUE");
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS referrals (
      id           VARCHAR(36)  NOT NULL PRIMARY KEY,
      referrer_id  VARCHAR(36)  NOT NULL,
      referred_id  VARCHAR(36)  NOT NULL,
      status       ENUM('pending','completed') NOT NULL DEFAULT 'pending',
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME     NULL,
      UNIQUE KEY uq_referred (referred_id)
    )
  `);
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const user = await queryOne<{ referral_code: string | null }>(
    "SELECT referral_code FROM users WHERE id = ?",
    [userId],
  );
  if (user?.referral_code) return user.referral_code;

  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const taken = await queryOne<{ id: string }>("SELECT id FROM users WHERE referral_code = ?", [code]);
    if (!taken) {
      await execute("UPDATE users SET referral_code = ? WHERE id = ?", [code, userId]);
      return code;
    }
  }
  throw new Error("Could not generate unique referral code");
}

export async function findReferrerByCode(code: string): Promise<{ id: string; first_name: string } | null> {
  return queryOne<{ id: string; first_name: string }>(
    "SELECT id, first_name FROM users WHERE referral_code = ? AND status = 'active'",
    [code.toUpperCase().trim()],
  );
}

export async function recordReferral(referrerId: string, referredId: string): Promise<void> {
  await execute(
    `INSERT IGNORE INTO referrals (id, referrer_id, referred_id, status)
     VALUES (?, ?, ?, 'pending')`,
    [createId("ref"), referrerId, referredId],
  );
}

export async function completeReferralOnFirstPublish(
  referredUserId: string,
): Promise<{ referrerId: string } | null> {
  const referral = await queryOne<{ id: string; referrer_id: string }>(
    "SELECT id, referrer_id FROM referrals WHERE referred_id = ? AND status = 'pending'",
    [referredUserId],
  );
  if (!referral) return null;

  // Verify this is indeed the first published request for this user
  const count = await queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM requests WHERE client_user_id = ? AND status = 'published'",
    [referredUserId],
  );
  if ((count?.cnt ?? 0) !== 1) return null;

  await execute(
    "UPDATE referrals SET status = 'completed', completed_at = NOW() WHERE id = ?",
    [referral.id],
  );
  return { referrerId: referral.referrer_id };
}

export async function getReferralStats(userId: string) {
  const user = await queryOne<{ referral_code: string | null }>(
    "SELECT referral_code FROM users WHERE id = ?",
    [userId],
  );

  const referrals = await query<{
    referred_id: string;
    referred_name: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  }>(
    `SELECT r.referred_id, r.status, r.created_at, r.completed_at,
            CONCAT(u.first_name, ' ', LEFT(u.last_name, 1), '.') AS referred_name
       FROM referrals r
       JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC`,
    [userId],
  );

  return {
    referral_code: user?.referral_code ?? null,
    total: referrals.length,
    completed: referrals.filter((r) => r.status === "completed").length,
    pending: referrals.filter((r) => r.status === "pending").length,
    referrals,
  };
}
