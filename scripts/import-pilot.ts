import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { channelMappings, approvers, identityMappings, tenants } from "../src/db/schema";
import { readPilotConfig } from "../src/config/pilot";

export async function importPilot(path: string): Promise<{ tenantId: string; configVersion: number; channels: number; approvers: number; identities: number }> {
  const config = await readPilotConfig(path);
  const { db, pool } = createDb(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.select({ configVersion: tenants.configVersion }).from(tenants).where(eq(tenants.id, config.tenantId)).limit(1);
      const configVersion = (existing[0]?.configVersion ?? 0) + 1;
      await tx.insert(tenants).values({ id: config.tenantId, slackTeamId: config.slackTeamId, active: true, configVersion }).onConflictDoUpdate({ target: tenants.id, set: { slackTeamId: config.slackTeamId, active: true, configVersion } });
      await tx.update(channelMappings).set({ enabled: false }).where(eq(channelMappings.tenantId, config.tenantId));
      await tx.update(approvers).set({ enabled: false }).where(eq(approvers.tenantId, config.tenantId));
      await tx.update(identityMappings).set({ enabled: false }).where(eq(identityMappings.tenantId, config.tenantId));
      let approverCount = 0;
      for (const channel of config.channels) {
        await tx.insert(channelMappings).values({ tenantId: config.tenantId, channelId: channel.channelId, repositoryId: channel.githubRepoId, repositoryOwner: channel.githubOwner, repositoryName: channel.githubRepo, installationId: channel.githubInstallationId, enabled: true, shared: false }).onConflictDoUpdate({ target: [channelMappings.tenantId, channelMappings.channelId], set: { repositoryId: channel.githubRepoId, repositoryOwner: channel.githubOwner, repositoryName: channel.githubRepo, installationId: channel.githubInstallationId, enabled: true, shared: false } });
        for (const slackUserId of channel.approverSlackIds) {
          await tx.insert(approvers).values({ tenantId: config.tenantId, slackUserId, enabled: true }).onConflictDoUpdate({ target: [approvers.tenantId, approvers.slackUserId], set: { enabled: true } });
          approverCount += 1;
        }
      }
      for (const identity of config.identities) {
        await tx.insert(identityMappings).values({ tenantId: config.tenantId, slackUserId: identity.slackUserId, githubLogin: identity.githubLogin, enabled: true }).onConflictDoUpdate({ target: [identityMappings.tenantId, identityMappings.slackUserId], set: { githubLogin: identity.githubLogin, enabled: true } });
      }
      return { tenantId: config.tenantId, configVersion, channels: config.channels.length, approvers: approverCount, identities: config.identities.length };
    });
  } finally {
    await pool.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const configPath = process.env.SIGNAL_PILOT_CONFIG_PATH ?? process.argv[2];
  if (!configPath) {
    console.error("SIGNAL_PILOT_CONFIG_PATH is required");
    process.exitCode = 1;
  } else {
    try {
      const result = await importPilot(configPath);
      console.log(`Pilot configuration imported: tenant=${result.tenantId}, version=${result.configVersion}, channels=${result.channels}, approvers=${result.approvers}, identities=${result.identities}.`);
    } catch {
      console.error("Pilot configuration import failed; verify the local JSON and database configuration.");
      process.exitCode = 1;
    }
  }
}
