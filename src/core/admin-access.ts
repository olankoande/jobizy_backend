import { execute, query, queryOne } from "./db";
import { createId } from "./store";

const BASE_ADMIN_PERMISSIONS = [
  "dashboard.view",
  "platform.view",
  "platform.edit",
  "users.view",
  "providers.view",
  "catalog.view",
  "zones.view",
  "plans.view",
  "plans.edit",
  "subscriptions.view",
  "subscriptions.edit",
  "requests.view",
  "requests.edit",
  "requests.workflow",
  "matching.view",
  "quotes.view",
  "quotes.edit",
  "quotes.workflow",
  "missions.view",
  "missions.edit",
  "missions.workflow",
  "conversations.view",
  "reviews.view",
  "disputes.view",
  "disputes.edit",
  "disputes.workflow",
  "notifications.view",
  "audit.view",
  "admins.view",
  "admins.edit",
];

const LEGACY_PERMISSION_IMPLICATIONS: Record<string, string[]> = {
  "platform.manage": ["platform.view", "platform.edit"],
  "plans.manage": ["plans.view", "plans.edit", "subscriptions.view", "subscriptions.edit"],
  "requests.manage": ["requests.view", "requests.edit", "requests.workflow"],
  "quotes.manage": ["quotes.view", "quotes.edit", "quotes.workflow"],
  "missions.manage": ["missions.view", "missions.edit", "missions.workflow"],
  "disputes.manage": ["disputes.view", "disputes.edit", "disputes.workflow"],
  "admins.manage": ["admins.view", "admins.edit"],
};

const IMPLIED_PERMISSION_SUFFIXES = [".edit", ".workflow"];

export const ALL_ADMIN_PERMISSIONS = [...new Set([...BASE_ADMIN_PERMISSIONS, ...Object.keys(LEGACY_PERMISSION_IMPLICATIONS)])];

export type AdminAccess = {
  isAdmin: boolean;
  roleCodes: string[];
  permissions: string[];
};

function parsePermissions(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function expandPermissions(permissions: string[]) {
  const granted = new Set<string>();
  const pending = [...permissions];

  while (pending.length > 0) {
    const permission = pending.pop();
    if (!permission || granted.has(permission)) continue;
    granted.add(permission);

    for (const implied of LEGACY_PERMISSION_IMPLICATIONS[permission] ?? []) {
      pending.push(implied);
    }

    if (IMPLIED_PERMISSION_SUFFIXES.some((suffix) => permission.endsWith(suffix))) {
      pending.push(permission.replace(/\.(edit|workflow)$/u, ".view"));
    }
  }

  return [...granted];
}

export async function ensureAdminAccessSchema() {
  await execute(
    `CREATE TABLE IF NOT EXISTS admin_roles (
      id CHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT DEFAULT NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      permissions_json JSON DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_admin_roles_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  await execute(
    `CREATE TABLE IF NOT EXISTS admin_user_roles (
      id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      admin_role_id CHAR(36) NOT NULL,
      status ENUM('active','inactive') NOT NULL DEFAULT 'active',
      assigned_by_user_id CHAR(36) DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_admin_user_role (user_id, admin_role_id),
      KEY idx_admin_user_roles_user (user_id),
      KEY idx_admin_user_roles_role (admin_role_id),
      CONSTRAINT fk_admin_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id),
      CONSTRAINT fk_admin_user_roles_role FOREIGN KEY (admin_role_id) REFERENCES admin_roles (id),
      CONSTRAINT fk_admin_user_roles_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES users (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const existingSuperAdmin = await queryOne<{ id: string }>(`SELECT id FROM admin_roles WHERE code = 'super_admin'`);
  if (!existingSuperAdmin) {
    await execute(
      `INSERT INTO admin_roles (id, code, name, description, status, is_system, permissions_json)
       VALUES (?, 'super_admin', 'Super Admin', 'Acces complet a la console Jobizy', 'active', 1, ?)`,
      [createId("arole"), JSON.stringify(ALL_ADMIN_PERMISSIONS)],
    );
  }

  const envAdminEmails = (process.env.ADMIN_EMAILS ?? "admin@jobizy.local")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (envAdminEmails.length === 0) return;

  const superAdminRole = await queryOne<{ id: string }>(`SELECT id FROM admin_roles WHERE code = 'super_admin'`);
  if (!superAdminRole) return;

  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) IN (${envAdminEmails.map(() => "?").join(", ")})`,
    envAdminEmails,
  );

  for (const user of users) {
    const existingAssignment = await queryOne<{ id: string }>(
      `SELECT id FROM admin_user_roles WHERE user_id = ? AND admin_role_id = ?`,
      [user.id, superAdminRole.id],
    );

    if (existingAssignment) {
      await execute(`UPDATE admin_user_roles SET status = 'active' WHERE id = ?`, [existingAssignment.id]);
    } else {
      await execute(
        `INSERT INTO admin_user_roles (id, user_id, admin_role_id, status, assigned_by_user_id)
         VALUES (?, ?, ?, 'active', NULL)`,
        [createId("aurole"), user.id, superAdminRole.id],
      );
    }
  }
}

export async function getAdminAccess(input: { userId: string; email: string; forceAdminHeader?: boolean }): Promise<AdminAccess> {
  const rows = await query<{ code: string; permissions_json: unknown }>(
    `SELECT ar.code, ar.permissions_json
       FROM admin_user_roles aur
       JOIN admin_roles ar ON ar.id = aur.admin_role_id
      WHERE aur.user_id = ?
        AND aur.status = 'active'
        AND ar.status = 'active'`,
    [input.userId],
  );

  const roleCodes = rows.map((row) => row.code);
  const permissions = expandPermissions([...new Set(rows.flatMap((row) => parsePermissions(row.permissions_json)))]);
  const envAdminEmails = (process.env.ADMIN_EMAILS ?? "admin@jobizy.local")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const legacyAdmin = envAdminEmails.includes(input.email.toLowerCase()) || input.forceAdminHeader === true;

  if (legacyAdmin && roleCodes.length === 0) {
    return { isAdmin: true, roleCodes: ["super_admin"], permissions: ALL_ADMIN_PERMISSIONS };
  }

  return {
    isAdmin: roleCodes.length > 0 || legacyAdmin,
    roleCodes: roleCodes.length > 0 ? roleCodes : legacyAdmin ? ["super_admin"] : [],
    permissions: permissions.length > 0 ? permissions : legacyAdmin ? ALL_ADMIN_PERMISSIONS : [],
  };
}
