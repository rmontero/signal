import { after } from "next/server";
import { createDb } from "../../../../db/client";
import { cleanupRetention } from "../../../../db/repositories";
import { recoverOutbox } from "../../../../services/recover-outbox";
import { createMaintenanceHandler } from "./handler";

export const runtime = "nodejs";
export const GET = createMaintenanceHandler({
  createDb, after, cleanupRetention, recoverOutbox,
  cronSecret: () => process.env.CRON_SECRET,
});
