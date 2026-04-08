import { loadEnvFile } from "./core/env";
import { ensureAdminAccessSchema } from "./core/admin-access";
import { createApp } from "./app";
import { startReminders } from "./services/reminders";
import { ensureReferralSchema } from "./services/referral";

loadEnvFile();

async function start() {
  await ensureAdminAccessSchema();
  await ensureReferralSchema();

  const port = Number(process.env.PORT ?? 3001);
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
