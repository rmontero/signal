import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";

const id = () => text("id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

export const tenants = pgTable("tenants", {
  id: id(), slackTeamId: text("slack_team_id").notNull(), active: boolean("active").default(true).notNull(),
  configVersion: integer("config_version").default(1).notNull(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.id] }), unique("tenants_slack_team_unique").on(table.slackTeamId)]);

export const channelMappings = pgTable("channel_mappings", {
  tenantId: text("tenant_id").notNull(), channelId: text("channel_id").notNull(), repositoryId: text("repository_id").notNull(),
  repositoryOwner: text("repository_owner").notNull(), repositoryName: text("repository_name").notNull(), installationId: text("installation_id").notNull(),
  shared: boolean("shared").default(false).notNull(), enabled: boolean("enabled").default(true).notNull(), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.channelId] }),
  unique("channel_mappings_repository_unique").on(table.tenantId, table.channelId, table.repositoryId),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "channel_mappings_tenant_fk" }),
]);

export const approvers = pgTable("approvers", {
  tenantId: text("tenant_id").notNull(), slackUserId: text("slack_user_id").notNull(), enabled: boolean("enabled").default(true).notNull(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.slackUserId] }), foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "approvers_tenant_fk" })]);

export const identityMappings = pgTable("identity_mappings", {
  tenantId: text("tenant_id").notNull(), slackUserId: text("slack_user_id").notNull(), githubLogin: text("github_login").notNull(), enabled: boolean("enabled").default(true).notNull(), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.slackUserId] }), foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "identity_mappings_tenant_fk" })]);

export const threads = pgTable("threads", {
  tenantId: text("tenant_id").notNull(), id: id(), channelId: text("channel_id").notNull(), threadTs: text("thread_ts").notNull(),
  linkedIssueId: text("linked_issue_id"), linkedIssueNumber: integer("linked_issue_number"), activeOperationId: text("active_operation_id"), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("threads_coordinate_unique").on(table.tenantId, table.channelId, table.threadTs),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "threads_tenant_fk" }),
  foreignKey({ columns: [table.tenantId, table.channelId], foreignColumns: [channelMappings.tenantId, channelMappings.channelId], name: "threads_channel_mapping_fk" }),
]);

export const inbox = pgTable("inbox", {
  tenantId: text("tenant_id").notNull(), id: id(), slackEventId: text("slack_event_id").notNull(), channelId: text("channel_id").notNull(),
  threadTs: text("thread_ts").notNull(), messageTs: text("message_ts").notNull(), actorSlackId: text("actor_slack_id").notNull(), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("inbox_event_unique").on(table.tenantId, table.slackEventId),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "inbox_tenant_fk" }),
  foreignKey({ columns: [table.tenantId, table.channelId], foreignColumns: [channelMappings.tenantId, channelMappings.channelId], name: "inbox_channel_mapping_fk" }),
]);

export const snapshots = pgTable("snapshots", {
  tenantId: text("tenant_id").notNull(), id: id(), threadId: text("thread_id").notNull(), content: jsonb("content").notNull(), snapshotHash: text("snapshot_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("snapshots_hash_unique").on(table.tenantId, table.snapshotHash),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "snapshots_tenant_fk" }),
  foreignKey({ columns: [table.tenantId, table.threadId], foreignColumns: [threads.tenantId, threads.id], name: "snapshots_thread_fk" }),
]);

export const proposals = pgTable("proposals", {
  tenantId: text("tenant_id").notNull(), id: id(), threadId: text("thread_id").notNull(), snapshotId: text("snapshot_id").notNull(), operationId: text("operation_id").notNull(),
  version: integer("version").notNull(), mutation: jsonb("mutation").notNull(), payloadHash: text("payload_hash").notNull(), actionFingerprint: text("action_fingerprint").notNull(),
  state: text("state").notNull().default("PENDING"), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("proposals_fingerprint_unique").on(table.tenantId, table.actionFingerprint), unique("proposals_operation_unique").on(table.tenantId, table.operationId),
  check("proposals_state_check", sql`${table.state} in ('PENDING','APPROVED','DISMISSED','SUPERSEDED','EXPIRED')`), uniqueIndex("proposals_active_thread_unique").on(table.tenantId, table.threadId).where(sql`${table.state} in ('PENDING','APPROVED')`),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "proposals_tenant_fk" }),
  foreignKey({ columns: [table.tenantId, table.threadId], foreignColumns: [threads.tenantId, threads.id], name: "proposals_thread_fk" }),
  foreignKey({ columns: [table.tenantId, table.snapshotId], foreignColumns: [snapshots.tenantId, snapshots.id], name: "proposals_snapshot_fk" }),
]);

export const operations = pgTable("operations", {
  tenantId: text("tenant_id").notNull(), id: id(), proposalId: text("proposal_id").notNull(), state: text("state").notNull().default("READY"), fencingToken: integer("fencing_token").default(0).notNull(),
  ownerAttemptId: text("owner_attempt_id"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }), resultExternalId: text("result_external_id"), resultExternalUrl: text("result_external_url"), errorCode: text("error_code"), resolutionNote: text("resolution_note"), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("operations_proposal_unique").on(table.tenantId, table.proposalId), unique("operations_identity_unique").on(table.tenantId, table.id, table.proposalId), check("operations_state_check", sql`${table.state} in ('READY','SENDING','SUCCEEDED','FAILED','UNKNOWN','STALE')`),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "operations_tenant_fk" }), foreignKey({ columns: [table.tenantId, table.proposalId], foreignColumns: [proposals.tenantId, proposals.id], name: "operations_proposal_fk" }),
]);

export const approvals = pgTable("approvals", {
  tenantId: text("tenant_id").notNull(), id: id(), proposalId: text("proposal_id").notNull(), operationId: text("operation_id").notNull(), version: integer("version").notNull(), payloadHash: text("payload_hash").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(), slackTeamId: text("slack_team_id").notNull(), channelId: text("channel_id").notNull(), actorSlackId: text("actor_slack_id").notNull(), approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("approvals_proposal_unique").on(table.tenantId, table.proposalId),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "approvals_tenant_fk" }), foreignKey({ columns: [table.tenantId, table.proposalId], foreignColumns: [proposals.tenantId, proposals.id], name: "approvals_proposal_fk" }), foreignKey({ columns: [table.tenantId, table.operationId, table.proposalId], foreignColumns: [operations.tenantId, operations.id, operations.proposalId], name: "approvals_operation_fk" }),
]);

export const observedEvents = pgTable("observed_events", {
  tenantId: text("tenant_id").notNull(), id: id(), source: text("source").notNull(), providerEventId: text("provider_event_id").notNull(), eventType: text("event_type").notNull(),
  channelId: text("channel_id"), threadTs: text("thread_ts"), messageTs: text("message_ts"), actorId: text("actor_id"),
  repositoryId: text("repository_id"), repositoryOwner: text("repository_owner"), repositoryName: text("repository_name"), installationId: text("installation_id"), pullRequestNumber: integer("pull_request_number"),
  payloadHash: text("payload_hash").notNull(), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), unique("observed_events_provider_unique").on(table.tenantId, table.source, table.providerEventId),
  check("observed_events_source_check", sql`${table.source} in ('slack','github')`),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "observed_events_tenant_fk" }),
]);

export const outbox = pgTable("outbox", {
  tenantId: text("tenant_id").notNull(), id: id(), taskId: text("task_id").notNull(), inboxId: text("inbox_id"), proposalId: text("proposal_id"), operationId: text("operation_id"), observerEventId: text("observer_event_id"), dispatchState: text("dispatch_state").notNull().default("PENDING"), executionState: text("execution_state").notNull().default("READY"), attempts: integer("attempts").default(0).notNull(), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }), triggerRunId: text("trigger_run_id"), createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }), check("outbox_one_entity_check", sql`num_nonnulls(${table.inboxId}, ${table.proposalId}, ${table.operationId}, ${table.observerEventId}) = 1`), check("outbox_dispatch_state_check", sql`${table.dispatchState} in ('PENDING','CLAIMED','DISPATCHED')`), check("outbox_execution_state_check", sql`${table.executionState} in ('READY','RUNNING','SUCCEEDED','FAILED','BLOCKED')`),
  foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "outbox_tenant_fk" }), foreignKey({ columns: [table.tenantId, table.inboxId], foreignColumns: [inbox.tenantId, inbox.id], name: "outbox_inbox_fk" }), foreignKey({ columns: [table.tenantId, table.proposalId], foreignColumns: [proposals.tenantId, proposals.id], name: "outbox_proposal_fk" }), foreignKey({ columns: [table.tenantId, table.operationId], foreignColumns: [operations.tenantId, operations.id], name: "outbox_operation_fk" }), foreignKey({ columns: [table.tenantId, table.observerEventId], foreignColumns: [observedEvents.tenantId, observedEvents.id], name: "outbox_observer_event_fk" }),
]);

export const audit = pgTable("audit", {
  tenantId: text("tenant_id").notNull(), id: id(), actorSlackId: text("actor_slack_id"), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), fromState: text("from_state"), toState: text("to_state"), payloadHash: text("payload_hash"), createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.id] }), foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: "audit_tenant_fk" })]);

export const schema = { tenants, channelMappings, approvers, identityMappings, threads, inbox, snapshots, proposals, operations, approvals, observedEvents, outbox, audit };
