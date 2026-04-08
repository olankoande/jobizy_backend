import { NextFunction, Request, Response } from "express";
import { queryOne } from "./db";
import { ApiError } from "./errors";
import { getAdminAccess } from "./admin-access";
import { User } from "./store";

export type AppRole = "user" | "provider" | "admin";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      role?: AppRole;
      adminPermissions?: string[];
      adminRoleCodes?: string[];
    }
  }
}

function parseToken(value?: string) {
  if (!value) {
    return null;
  }

  const [type, token] = value.split(" ");
  if (type !== "Bearer" || !token?.startsWith("token-")) {
    return null;
  }

  return token.replace("token-", "");
}

function toBoolean(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function computeRole(user: User, isAdmin: boolean): AppRole {
  if (isAdmin) {
    return "admin";
  }
  if (user.is_provider_enabled) {
    return "provider";
  }

  return "user";
}

async function populateRequestUser(req: Request) {
  const userId = parseToken(req.header("Authorization"));
  if (!userId) {
    return;
  }

  const row = await queryOne<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    locale: string;
    email_verified_at: string | null;
    is_client_enabled: number;
    is_provider_enabled: number;
    status: "active" | "suspended";
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, email, first_name, last_name, phone, locale, email_verified_at,
            is_client_enabled, is_provider_enabled, status, created_at, updated_at
       FROM users
      WHERE id = ?`,
    [userId],
  );

  if (row) {
    const user: User = {
      id: row.id,
      email: row.email,
      password: "",
      first_name: row.first_name ?? "",
      last_name: row.last_name ?? "",
      phone: row.phone ?? undefined,
      locale: row.locale,
      email_verified_at: row.email_verified_at,
      is_client_enabled: toBoolean(row.is_client_enabled),
      is_provider_enabled: toBoolean(row.is_provider_enabled),
      status: row.status,
      role: "user",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    const access = await getAdminAccess({
      userId: user.id,
      email: user.email,
      forceAdminHeader: req.header("x-role") === "admin",
    });

    user.role = computeRole(user, access.isAdmin);
    req.user = user;
    req.role = user.role;
    req.adminPermissions = access.permissions;
    req.adminRoleCodes = access.roleCodes;
  }
}

export function authOptional(req: Request, _res: Response, next: NextFunction) {
  Promise.resolve()
    .then(async () => {
      await populateRequestUser(req);
      next();
    })
    .catch(next);
}

export function authRequired(req: Request, _res: Response, next: NextFunction) {
  Promise.resolve()
    .then(async () => {
      await populateRequestUser(req);

      if (!req.user) {
        throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
      }

      if (req.user.status === "suspended") {
        throw new ApiError(403, "ACCOUNT_SUSPENDED", "Account is suspended");
      }

      next();
    })
    .catch(next);
}

export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, "FORBIDDEN", "Forbidden"));
    }

    next();
  };
}

export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
    }

    const granted = new Set(req.adminPermissions ?? []);
    if (!permissions.every((permission) => granted.has(permission))) {
      return next(new ApiError(403, "FORBIDDEN", "Missing required admin permission"));
    }

    next();
  };
}
