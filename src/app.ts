import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import swaggerUi from "swagger-ui-express";
import { authOptional } from "./core/auth";
import { pingDatabase } from "./core/db";
import { errorMiddleware } from "./core/http";
import { openApiSpec } from "./docs/openapi";
import { adminRouter } from "./modules/admin";
import { authRouter } from "./modules/auth";
import { billingRouter } from "./modules/billing";
import { catalogRouter } from "./modules/catalog";
import { providersRouter } from "./modules/providers";
import { referralsRouter } from "./modules/referrals";
import { requestsRouter } from "./modules/requests";
import { webhooksRouter } from "./modules/webhooks";

function parseAllowedOrigins() {
  return (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();
  const allowedOrigins = parseAllowedOrigins();
  const allowCredentials = (process.env.CORS_ALLOW_CREDENTIALS ?? "true") === "true";
  const legacyApiPaths = [
    "/auth/register",
    "/auth/login",
    "/auth/google",
    "/auth/refresh",
    "/auth/logout",
    "/auth/password/request",
    "/auth/password/reset",
    "/users/me",
  ];

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error("CORS origin not allowed"));
      },
      credentials: allowCredentials,
    }),
  );
  // Serve generated invoice PDFs
  app.use("/static/invoices", express.static(path.resolve(process.cwd(), "storage", "invoices")));
  // Raw body required for Stripe webhook signature verification — must be registered before express.json()
  app.use("/api/v1/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(morgan("dev"));
  app.use(authOptional);

  app.get("/health", async (_req, res, next) => {
    try {
      await pingDatabase();
      res.json({ status: "ok", database: "connected" });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/v1/openapi.json", (_req, res) => res.json(openApiSpec));
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

  for (const path of legacyApiPaths) {
    app.all(path, (req, res) => {
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      res.redirect(307, `/api/v1${path}${query}`);
    });
  }

  app.use("/api/v1", authRouter());
  app.use("/api/v1", catalogRouter());
  app.use("/api/v1", providersRouter());
  app.use("/api/v1", requestsRouter());
  app.use("/api/v1", billingRouter());
  app.use("/api/v1", referralsRouter());
  app.use("/api/v1", webhooksRouter());
  app.use("/api/v1", adminRouter());

  app.use(errorMiddleware);

  return app;
}
