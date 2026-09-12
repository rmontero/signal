import { readFile } from "node:fs/promises";
import { z } from "zod";

const providerId = z.string().trim().min(2).max(255);
const slackId = z.string().regex(/^[A-Z][A-Z0-9_-]{1,127}$/);

export const PilotConfigSchema = z.object({
  tenantId: providerId,
  slackTeamId: slackId,
  workspaceTimezone: z.string().trim().min(1).max(100),
  channels: z.array(z.object({
    channelId: slackId,
    githubInstallationId: providerId,
    githubRepoId: providerId,
    githubOwner: z.string().trim().min(1).max(100),
    githubRepo: z.string().trim().min(1).max(100),
    approverSlackIds: z.array(slackId).min(1),
  }).strict()).min(1),
  identities: z.array(z.object({ slackUserId: slackId, githubLogin: z.string().trim().min(1).max(100) }).strict()),
  auth0Subjects: z.array(z.object({ issuer: z.string().url(), subject: z.string().trim().min(1).max(255) }).strict()).optional().default([]),
}).strict();

export type PilotConfig = z.infer<typeof PilotConfigSchema>;

export function parsePilotConfig(input: unknown): PilotConfig {
  const config = PilotConfigSchema.parse(input);
  const channels = new Set<string>();
  const approvers = new Set<string>();
  for (const channel of config.channels) {
    if (channels.has(channel.channelId)) throw new Error("pilot_duplicate_channel");
    channels.add(channel.channelId);
    for (const approver of channel.approverSlackIds) {
      const key = `${channel.channelId}:${approver}`;
      if (approvers.has(key)) throw new Error("pilot_duplicate_approver");
      approvers.add(key);
    }
  }
  const identities = new Set<string>();
  for (const identity of config.identities) {
    if (identities.has(identity.slackUserId)) throw new Error("pilot_duplicate_identity");
    identities.add(identity.slackUserId);
  }
  return config;
}

export async function readPilotConfig(path: string): Promise<PilotConfig> {
  const content = await readFile(path, "utf8");
  return parsePilotConfig(JSON.parse(content));
}
