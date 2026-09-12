import { createAppAuth } from "@octokit/auth-app";
import { createGitHubReadClient, type GitHubReadClient, type GitHubReadClientOptions } from "./github-read";
import { createGitHubWriteClient, type GitHubWriteClient, type GitHubWriteClientOptions } from "./github-write-standalone.mts";

export type GitHubAppCredentials = {
  appId: string;
  privateKey: string;
};

function validateCredentials(credentials: GitHubAppCredentials): void {
  if (!/^\d+$/.test(credentials.appId) || !credentials.privateKey.includes("BEGIN")) {
    throw new Error("github_app_configuration_invalid");
  }
}

export async function mintGitHubInstallationToken(
  credentials: GitHubAppCredentials,
  installationId: string,
): Promise<string> {
  validateCredentials(credentials);
  if (!/^\d+$/.test(installationId)) throw new Error("github_installation_invalid");
  const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
  const result = await auth({ type: "installation", installationId });
  if (!result.token) throw new Error("github_installation_token_missing");
  return result.token;
}

export async function createGitHubAppClients(
  credentials: GitHubAppCredentials,
  installationId: string,
  options: { apiBaseUrl?: string; fetchImpl?: typeof fetch; wait?: (milliseconds: number) => Promise<void>; maxReadRetries?: number } = {},
): Promise<{ read: GitHubReadClient; write: GitHubWriteClient }> {
  const token = await mintGitHubInstallationToken(credentials, installationId);
  const readOptions: GitHubReadClientOptions = { token, ...options };
  const writeOptions: GitHubWriteClientOptions = { token, apiBaseUrl: options.apiBaseUrl, fetchImpl: options.fetchImpl };
  return { read: createGitHubReadClient(readOptions), write: createGitHubWriteClient(writeOptions) };
}
