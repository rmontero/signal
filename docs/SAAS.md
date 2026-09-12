# SaaS after the MVP

This work is outside the six-hour MVP and begins after V-02. The pilot is one manually configured workspace, not self-service SaaS. Existing tenant-scoped relationships are necessary foundations, not proof of multi-tenant readiness.

Before admitting a second customer, implement authenticated installation onboarding with anti-CSRF state, explicit Slack workspace/GitHub installation linking, verified repository ownership and tenant-admin authorization. Do not infer account linkage from email or display names. Store encrypted per-tenant credential references and rotate/revoke access without allowing already queued work to continue under stale authorization. Handle uninstall, token revocation and repository removal as explicit lifecycle events.

Add PostgreSQL row-level security with transaction-local tenant context and separate migration privileges; test connection reuse so one tenant cannot inherit another's context. Retain composite foreign keys and application authorization. Add per-tenant concurrency, request/token budgets, retention/deletion controls, audit export, queue fairness and administrative approver management. Billing and broader integrations remain separate product decisions.

The admission gate requires two real isolated test tenants and negative tests for reads, writes, task execution, inspector sessions, credential lookup, outbox replay, repository remapping, revocation and cleanup. Backfill/migration scripts must fail on mixed-tenant references. Unknown GitHub writes must remain discoverable during offboarding until their disposition is recorded; removal cannot reset replay protection. Demonstrate deletion of local content and separately disclose provider retention limits.

Maintain the existing Slack approval authority and two allowed mutation types throughout expansion. A future web approval flow or additional GitHub capability requires a new product decision, threat review and contract, not an inferred consequence of Auth0 login. See [CONTRACTS.md](CONTRACTS.md) and [roadmap.md](../roadmap.md).
