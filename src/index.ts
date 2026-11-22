import "./core/load-env";
import { ensureAdminAccessSchema } from "./core/admin-access";
import { createApp } from "./app";
import { startReminders } from "./services/reminders";
import { ensureReferralSchema } from "./services/referral";

function warnMisconfig() {
  const frontendUrl = process.env.FRONTEND_URL ?? "";
  const appBaseUrl = process.env.APP_BASE_URL ?? "";
  if (!frontendUrl || frontendUrl.includes("localhost")) {
    console.warn(
      `[config] WARNING: FRONTEND_URL="${frontendUrl || "(unset)"}" — email links will not reach the production frontend. Set FRONTEND_URL to the public frontend URL.`,
    );
  }
  if (!appBaseUrl || appBaseUrl.includes("localhost")) {
    console.warn(
      `[config] WARNING: APP_BASE_URL="${appBaseUrl || "(unset)"}" — Set APP_BASE_URL to the public backend URL.`,
    );
  }
}

async function runStartupMigrations(attempt = 1): Promise<void> {
  try {
    await Promise.all([ensureAdminAccessSchema(), ensureReferralSchema()]);
    console.log("[startup] schema checks done");
  } catch (error) {
    const maxAttempts = 5;
    console.error(`[startup] schema checks failed (attempt ${attempt}/${maxAttempts})`, error);
    if (attempt < maxAttempts) {
      setTimeout(() => void runStartupMigrations(attempt + 1), attempt * 5_000);
    }
  }
}

async function start() {
  warnMisconfig();

  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();

  // Listen immediately (bind on all interfaces) so the platform healthcheck / frontend
  // can connect; DB migrations run in the background instead of blocking startup.
  app.listen(port, "0.0.0.0", () => {
    console.log(`Jobizy backend listening on port ${port}`);
  });

  void runStartupMigrations();
  startReminders();
}

start().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
