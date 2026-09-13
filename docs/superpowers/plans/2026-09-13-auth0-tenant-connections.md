# Auth0 Tenant Onboarding and Provider Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pilot-only dashboard authority with Auth0-backed tenant membership and add secure signup/login plus tenant-scoped GitHub and Slack connection settings.

**Architecture:** Auth0 Universal Login supplies the verified subject; PostgreSQL maps that subject to a tenant membership. A server-only tenant resolver feeds the dashboard and settings. GitHub uses the existing App installation authority, while Slack uses OAuth with expiring state/PKCE; provider secrets are encrypted at rest and never sent to the browser.

**Tech Stack:** Next.js 16 App Router, TypeScript, `@auth0/nextjs-auth0`, Neon PostgreSQL, Drizzle ORM, Node.js 24, Web Crypto AES-256-GCM, existing GitHub App and Slack adapters.

**Spec:** `docs/superpowers/specs/2026-09-13-auth0-tenant-connections-design.md`

## Global Constraints

- Tenant identity is derived from a verified Auth0 subject and persisted membership; client tenant claims are rejected.
- `SIGNAL_DASHBOARD_TENANT_ID` is not application authority and `SIGNAL_PILOT_CONFIG_PATH` is operator/bootstrap-only.
- GitHub write authority remains the existing GitHub App plus named Slack approval; personal GitHub OAuth tokens are not accepted.
- Slack OAuth tokens and encryption keys never appear in logs, task metadata, HTML, JSON responses, or client bundles.
- Every provider connection, OAuth state, membership lookup, and mapping mutation is tenant-scoped.
- OAuth state is single-use, time-limited, bound to Auth0 subject and tenant, and protected with PKCE where the provider supports it.
- Disconnect revokes/marks state and disables dependent mappings; it does not erase audit or replay protection.
- Preserve the existing uncommitted expiry fix in `src/db/approval-persistence.ts`; do not edit `tasks.md` from feature workers.
- Do not commit, push, deploy, or contact Auth0/GitHub/Slack during implementation without explicit action-time authorization.

### Task 1: Add Auth0 server client and tenant resolver ✅

**Files:**
- Create: `src/lib/auth0.ts`
- Create: `src/lib/tenant-context.ts`
- Create: `src/app/auth/login/route.ts`
- Create: `src/app/auth/signup/route.ts`
- Create: `src/app/auth/logout/route.ts`
- Create: `src/app/auth/callback/route.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/page.tsx`
- Test: `tests/unit/auth-routes.test.ts`
- Test: `tests/unit/tenant-context.test.ts`

**Interfaces:**
- `auth0`: configured `Auth0Client` from `@auth0/nextjs-auth0/server`.
- `resolveViewerTenant(): Promise<{ subject: string; tenantId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null>`: reads the verified server session and membership repository; never accepts request tenant input.
- Auth routes redirect to Auth0 and preserve only a validated same-origin `returnTo`.

- [ ] **Step 1: Write failing tests** for unauthenticated route behavior, same-origin return paths, signup `screen_hint=signup`, logout, subject normalization rejection, and cross-tenant membership denial.
- [ ] **Step 2: Run focused tests** with `node --import tsx/esm --test tests/unit/auth-routes.test.ts tests/unit/tenant-context.test.ts` and verify they fail because the interfaces do not exist.
- [ ] **Step 3: Add the Auth0 client and route handlers** using the SDK’s server client and the required `AUTH0_SECRET`, `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` settings.
- [ ] **Step 4: Implement `resolveViewerTenant()`** so session subject is trimmed/validated, membership is loaded server-side, inactive memberships return null, and no tenant ID comes from browser input.
- [ ] **Step 5: Re-run focused tests** and verify all authentication/tenant-boundary cases pass without exposing session errors.

### Task 2: Add tenant memberships and first-signup onboarding

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0009_auth0_memberships.sql`
- Create: `src/db/membership-repository.ts`
- Create: `src/app/onboarding/page.tsx`
- Create: `src/app/onboarding/actions.ts`
- Modify: `src/app/auth/callback/route.ts`
- Test: `tests/integration/membership.test.ts`
- Test: `tests/unit/onboarding.test.ts`

**Interfaces:**
- `findMembershipBySubject(db, subject): Promise<Membership | null>`.
- `createTenantForSubject(db, input: { subject: string; tenantName: string }): Promise<{ tenantId: string; role: "OWNER" }>`.
- `requireTenantAdmin(viewer): void`.

- [ ] **Step 1: Write failing integration tests** for first signup, duplicate callback idempotency, inactive membership, cross-tenant lookup, and transaction rollback.
- [ ] **Step 2: Run the isolated integration tests** and confirm the tables/functions are absent.
- [ ] **Step 3: Add `tenant_memberships`** with tenant-scoped composite keys, unique `(tenant_id, auth0_subject)`, roles `OWNER|ADMIN|MEMBER`, and active state.
- [ ] **Step 4: Implement transactional first-signup creation** with a generated opaque tenant ID and a safe default display name; never use email as identity.
- [ ] **Step 5: Add onboarding page/action** that requires a verified session and creates only the current subject’s tenant.
- [ ] **Step 6: Generate/check the migration and run isolated migration/integration tests** without applying it to shared application data.

### Task 3: Replace dashboard env authority with Auth0 membership

**Files:**
- Modify: `src/lib/monitoring-data.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/monitoring-dashboard.tsx`
- Modify: `src/lib/dashboard-settings.ts`
- Test: `tests/unit/monitoring-data.test.ts`
- Test: `tests/unit/monitoring.test.ts`

**Interfaces:**
- `loadMonitoringDashboardData(dependencies?)` obtains the tenant from `resolveViewerTenant()` and passes only that server-derived ID to tenant-scoped repositories.
- The unavailable state remains safe and contains no private records.

- [ ] **Step 1: Extend failing tests** for Auth0 subject-to-tenant success, anonymous denial, inactive membership, cross-tenant denial, and removal of `SIGNAL_DASHBOARD_TENANT_ID` authority.
- [ ] **Step 2: Implement the default resolver dependency** and remove the requirement that the dashboard have an env-selected tenant for authenticated reads.
- [ ] **Step 3: Preserve the public setup shell** for anonymous users and ensure the Settings copy distinguishes authentication from provider configuration.
- [ ] **Step 4: Run the monitoring test suite** and verify no private text is rendered on denial paths.

### Task 4: Add encrypted provider connection persistence and OAuth state

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0010_provider_connections.sql`
- Create: `src/lib/connection-crypto.ts`
- Create: `src/lib/oauth-state.ts`
- Create: `src/db/connection-repository.ts`
- Test: `tests/unit/connection-crypto.test.ts`
- Test: `tests/unit/oauth-state.test.ts`
- Test: `tests/integration/connection-repository.test.ts`

**Interfaces:**
- `sealConnectionSecret(plaintext: string, key: string): string` and `openConnectionSecret(ciphertext: string, key: string): string` using authenticated encryption.
- `createOAuthState(input: { tenantId: string; subject: string; provider: "github" | "slack"; returnTo: string }): Promise<string>`.
- `consumeOAuthState(state: string, input: { subject: string; provider: "github" | "slack" }): Promise<{ tenantId: string; returnTo: string }>`. 
- `upsertProviderConnection(db, input)` and `revokeProviderConnection(db, input)` are tenant-admin scoped.

- [ ] **Step 1: Write failing crypto/state tests** for round-trip, wrong key, tampering, empty key, expiry, replay, subject mismatch, provider mismatch, and return-path validation.
- [ ] **Step 2: Implement AES-256-GCM sealing** with random nonce and authenticated versioned envelope; reject malformed input and never log plaintext.
- [ ] **Step 3: Add expiring single-use `oauth_states`** bound to tenant, subject, provider, nonce/PKCE verifier, and return path.
- [ ] **Step 4: Add `provider_connections`** with tenant/provider uniqueness, external account IDs, encrypted secret, scopes, status, and timestamps.
- [ ] **Step 5: Implement repository methods** with tenant and role checks, revocation, and dependent channel-mapping disablement.
- [ ] **Step 6: Run unit, isolated integration, migration, and redaction tests.**

### Task 5: Implement GitHub App installation connection

**Files:**
- Create: `src/app/api/settings/connections/github/start/route.ts`
- Create: `src/app/api/settings/connections/github/callback/route.ts`
- Create: `src/services/github-connection.ts`
- Modify: `src/adapters/github-app.ts`
- Test: `tests/unit/github-connection.test.ts`

**Interfaces:**
- `beginGitHubInstallation(viewer, returnTo): Promise<NextResponse>` creates state and redirects to the configured GitHub App installation URL.
- `completeGitHubInstallation(input): Promise<{ connectionId: string; installationId: string }>` consumes state, verifies the installation belongs to the intended account/repository scope, and persists only metadata.

- [ ] **Step 1: Write failing tests** for unauthenticated start, non-admin denial, state mismatch, missing installation ID, installation/account mismatch, and successful metadata persistence.
- [ ] **Step 2: Implement the start route** with a same-origin return path and single-use state; do not request personal GitHub OAuth tokens.
- [ ] **Step 3: Implement callback verification** using the existing GitHub App client/read adapter and strict repository/installation identity checks.
- [ ] **Step 4: Persist the tenant connection and offer explicit repository/channel mapping next steps** without silently selecting a repository.
- [ ] **Step 5: Run focused tests and verify no private installation token or GitHub response is serialized.**

### Task 6: Implement Slack OAuth connection

**Files:**
- Create: `src/app/api/settings/connections/slack/start/route.ts`
- Create: `src/app/api/settings/connections/slack/callback/route.ts`
- Create: `src/services/slack-connection.ts`
- Modify: `src/adapters/slack-api.ts`
- Test: `tests/unit/slack-connection.test.ts`

**Interfaces:**
- `beginSlackOAuth(viewer, returnTo): Promise<NextResponse>` creates state/PKCE and redirects to Slack OAuth.
- `completeSlackOAuth(input): Promise<{ connectionId: string; teamId: string; botUserId: string; scopes: string[] }>` validates the callback, encrypts the bot token, and persists safe workspace metadata.

- [ ] **Step 1: Write failing tests** for unauthenticated/admin denial, state replay/expiry, callback team mismatch, missing required scopes, token sealing, and successful connection persistence.
- [ ] **Step 2: Implement Slack OAuth start** with minimum required scopes and server-only state/PKCE storage.
- [ ] **Step 3: Implement callback exchange** through Slack’s OAuth API, validate `team_id`, bot identity, and required scopes, then seal the token.
- [ ] **Step 4: Add revoke/disconnect behavior** that marks the connection revoked and disables affected mappings without deleting audit/replay state.
- [ ] **Step 5: Run focused tests and verify token values never reach responses, logs, or rendered Settings.**

### Task 7: Build the authenticated Settings connection UI

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/components/settings-connections.tsx`
- Create: `src/app/api/settings/connections/route.ts`
- Modify: `src/components/monitoring-dashboard.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/unit/settings-connections.test.ts`
- Test: `tests/e2e/settings-auth.spec.ts`

**Interfaces:**
- `listTenantConnections(viewer): Promise<SafeConnectionSummary[]>` returns provider, display name, external ID suffix if safe, scopes, status, and timestamps—never credentials.
- `POST /api/settings/connections/:provider/revoke` requires an authenticated tenant admin and returns a sanitized status.

- [ ] **Step 1: Write failing component/API tests** for anonymous redirect/denial, safe connected/disconnected states, admin-only revoke, and no token rendering.
- [ ] **Step 2: Implement the authenticated Settings page** with GitHub and Slack cards, connect links, connection status, scopes, and revocation confirmation.
- [ ] **Step 3: Wire callback return paths and refresh state** without trusting browser tenant IDs or provider payloads.
- [ ] **Step 4: Add accessible loading, error, and unavailable states** consistent with the existing dashboard visual language.
- [ ] **Step 5: Run focused unit/e2e tests and verify the page remains safe with missing Auth0/provider configuration.**

### Task 8: Documentation, release configuration, and full verification

**Files:**
- Modify: `.env.example`
- Modify: `docs/SAAS.md`
- Modify: `docs/INFRASTRUCTURE.md`
- Modify: `docs/ONBOARDING.md`
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/OPERATIONS.md`
- Test: `tests/unit/preflight.test.ts`
- Test: `scripts/check_docs.py`

- [ ] **Step 1: Document Auth0 callback/logout URLs**, `CONNECTIONS_ENCRYPTION_KEY`, provider app settings, and the fact that tenant IDs are server-derived.
- [ ] **Step 2: Mark `SIGNAL_DASHBOARD_TENANT_ID` as legacy pilot-only** and `SIGNAL_PILOT_CONFIG_PATH` as operator/bootstrap-only; do not remove pilot import until migration is verified.
- [ ] **Step 3: Add configuration checks** that distinguish Auth0 session readiness, provider OAuth configuration, and live provider acceptance without claiming connectivity from presence alone.
- [ ] **Step 4: Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:migrations`, `npm run build`, `npm run docs:check`, and `git diff --check` under Node 24.
- [ ] **Step 5: Record live Auth0/GitHub/Slack acceptance only after explicit operator setup and action-time authorization.**
