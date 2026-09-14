/**
 * Offline browser coverage of the real Settings component and its API contract.
 * Auth0/tenant/SQL enforcement is exercised in settings-connections.test.ts.
 * This spec neither signs in to Auth0 nor contacts GitHub/Slack/a database.
 * Run with an installed @playwright/test harness; do not install it implicitly:
 * playwright test tests/e2e/settings-auth.spec.ts --reporter=line
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SettingsSnapshot } from "../../src/components/settings-connections";

const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://signal.example";
const stamp = "2026-09-13T12:00:00.000Z";
let script: string;
let styles: string;
const initial = (): SettingsSnapshot => ({
  canManage: true, setup: { github: true, slack: true },
  connections: [{ provider: "github", displayName: "Synthetic team", externalIdSuffix: "6789", scopes: ["issues:write"], status: "ACTIVE", createdAt: stamp, updatedAt: stamp, revokedAt: null }],
});

test.beforeAll(async () => {
  // Bundle the production component in memory. No test-only app routes or files.
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: { contents: 'import {createRoot} from "react-dom/client"; import {SettingsConnections} from "./src/components/settings-connections"; createRoot(document.getElementById("root")).render(<SettingsConnections />);', resolveDir: root, loader: "tsx" },
  });
  script = result.outputFiles[0].text;
  styles = await readFile(new URL("../../src/app/globals.css", import.meta.url), "utf8");
});

async function mount(page: Page, snapshot = initial(), readGate: Promise<void> = Promise.resolve()) {
  const control = { snapshot, reads: 0, readStatus: 200, revokeStatus: 200, writes: [] as unknown[], unexpected: [] as string[] };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { control.unexpected.push(url.origin); await route.abort(); return; }
    if (url.pathname === "/settings") {
      await route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/settings.css"></head><body><main class="connection-settings-page"><h1>Settings</h1><div id="root"></div></main><script src="/settings.js"></script></body></html>' });
    } else if (url.pathname === "/settings.js") {
      await route.fulfill({ contentType: "text/javascript", body: script });
    } else if (url.pathname === "/settings.css") {
      await route.fulfill({ contentType: "text/css", body: styles });
    } else if (url.pathname === "/api/settings/connections") {
      control.reads++; await readGate;
      await route.fulfill({ status: control.readStatus, json: control.readStatus === 200 ? control.snapshot : { status: "unavailable", privateError: "PRIVATE_SERVER_DETAILS" } });
    } else if (url.pathname === "/api/settings/connections/github/revoke") {
      expect(route.request().method()).toBe("POST");
      control.writes.push(route.request().postDataJSON());
      if (control.revokeStatus === 200) control.snapshot = { ...control.snapshot, connections: control.snapshot.connections.map((row) => ({ ...row, status: "REVOKED", revokedAt: stamp })) };
      await route.fulfill({ status: control.revokeStatus, json: { status: control.revokeStatus === 200 ? "revoked" : "unavailable", privateError: "PRIVATE_SERVER_DETAILS" } });
    } else {
      control.unexpected.push(url.pathname); await route.abort();
    }
  });
  await page.goto(`${origin}/settings`);
  return control;
}

test("loading announces progress; persisted status and local connect links remain honest", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const control = await mount(page, initial(), gate);
  await expect(page.getByText("Loading connections…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh connections" })).toBeDisabled();
  release();
  await expect(page.getByText("Connection saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByText(/Trusted GitHub installation enrollment/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Reconnect GitHub" })).toHaveAttribute("href", "/api/settings/connections/github/start?returnTo=%2Fsettings");
  await expect(page.getByRole("link", { name: "Connect Slack" })).toHaveAttribute("href", "/api/settings/connections/slack/start?returnTo=%2Fsettings");
  expect(control.unexpected).toEqual([]);
});

test("disconnect requires explicit confirmation and cancel restores focus without a write", async ({ page }) => {
  const control = await mount(page);
  const disconnect = page.getByRole("button", { name: "Disconnect GitHub", exact: true });
  await disconnect.click();
  await expect(page.getByRole("checkbox")).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirm disconnect" })).toBeDisabled();
  expect(control.writes).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(disconnect).toBeFocused();
  expect(control.writes).toEqual([]);
});

test("confirmed disconnect posts only confirmation and reloads persisted state", async ({ page }) => {
  const control = await mount(page);
  await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByText("Disconnected", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Connection disconnected in Signal. Dependent mappings are disabled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh connections" })).toBeFocused();
  expect(control.writes).toEqual([{ confirm: true }]);
  expect(control.reads).toBe(2);
  expect(control.unexpected).toEqual([]);
});

test("a revoked session clears old cards and a failing revoke never reflects server errors", async ({ page }) => {
  const control = await mount(page);
  control.revokeStatus = 401;
  await page.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByRole("alert")).toContainText("Refresh connection status before trying again");
  await expect(page.getByText("Synthetic team")).toHaveCount(0);
  await expect(page.getByText("PRIVATE_SERVER_DETAILS")).toHaveCount(0);
  control.readStatus = 401;
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect(page.getByRole("alert")).toContainText("Connections are unavailable");
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/auth/login?returnTo=%2Fsettings");
  expect(control.writes).toEqual([{ confirm: true }]);
});

test("members receive safe read-only cards and unconfigured providers have no connect links", async ({ page }) => {
  const control = await mount(page, { ...initial(), canManage: false });
  await expect(page.getByText(/Only workspace owners and administrators/)).toBeVisible();
  await expect(page.getByRole("link", { name: /connect/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /disconnect/i })).toHaveCount(0);
  control.snapshot = { ...initial(), setup: { github: false, slack: false } };
  await page.getByRole("button", { name: "Refresh connections" }).click();
  await expect(page.getByText(/Connection setup is unavailable/)).toHaveCount(2);
  await expect(page.getByRole("link", { name: /connect/i })).toHaveCount(0);
  expect(control.writes).toEqual([]);
});
