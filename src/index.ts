import { loadEnvFile } from "./core/env";
import { ensureAdminAccessSchema } from "./core/admin-access";
import { createApp } from "./app";
import { startReminders } from "./services/reminders";
import { ensureReferralSchema } from "./services/referral";

loadEnvFile();

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

async function start() {
  await ensureAdminAccessSchema();
  await ensureReferralSchema();

  warnMisconfig();

  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();

  app.listen(port, () => {
    console.log(`Jobizy backend listening on http://localhost:${port}`);
  });

  startReminders();
}

start().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
