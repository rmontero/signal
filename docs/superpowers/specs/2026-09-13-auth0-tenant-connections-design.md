# Auth0 Tenant Onboarding and Provider Connections

## Decision

Signal will use Auth0 Universal Login for authentication, PostgreSQL for tenant membership and provider-connection state, the existing GitHub App installation model for GitHub access, and Slack OAuth for Slack workspace access. Tenant identity will be derived only from a verified Auth0 subject and a server-side membership lookup.

`SIGNAL_DASHBOARD_TENANT_ID` is an operator-only legacy pilot selector and will not be used as tenant authority in the authenticated application. `SIGNAL_PILOT_CONFIG_PATH` remains a local/CI bootstrap input for importing an initial pilot, not a signup or runtime setting. Future tenant setup persists provider mappings and connection metadata in PostgreSQL.

## User flows

1. `/auth/login` redirects to Auth0 Universal Login.
2. `/auth/signup` redirects to Auth0 with `screen_hint=signup`.
3. On callback, the server resolves the Auth0 subject. A new subject is sent to `/onboarding`; the onboarding action creates one tenant and an `OWNER` membership transactionally. Existing members go to the dashboard.
4. `/settings` requires an authenticated session and an active tenant membership. GitHub starts a GitHub App installation flow; Slack starts Slack OAuth with state and PKCE. Each callback verifies state, provider identity, requested tenant membership, and configured scopes before storing the connection.
5. Disconnect/revoke is tenant-admin-only, marks the connection revoked, disables dependent mappings, and never deletes audit/replay records.

## Data and security

Add tenant-scoped `tenant_memberships`, `provider_connections`, and expiring `oauth_states` tables with composite foreign keys. Store Auth0 subjects and provider IDs as opaque identifiers. Encrypt Slack access tokens with a server-only `CONNECTIONS_ENCRYPTION_KEY`; never serialize tokens, provider secrets, or raw OAuth responses. GitHub stores installation metadata and uses the existing server GitHub App credentials for actions.

The authenticated dashboard loader will call a server-only `resolveViewerTenant()` function and will not accept tenant IDs from query strings, headers, cookies created by the browser, or page props. All connection mutations will require the resolved tenant and an `OWNER` or `ADMIN` membership.

## Explicit non-goals

This change does not add a web approval path, personal GitHub OAuth write authority, multi-tenant billing, automatic repository selection without explicit operator confirmation, or optional Auth0/CopilotKit proposal explanation. Existing Slack named-approver authority and the two allowed GitHub mutations remain unchanged.

## Acceptance

Tests must cover unauthenticated denial, cross-tenant membership denial, first-signup tenant creation, duplicate signup idempotency, OAuth state expiry/replay/provider mismatch, encrypted-token redaction, tenant-admin authorization, disconnect behavior, and settings rendering without credentials. Live Auth0/GitHub/Slack acceptance remains a separately recorded provider gate.
