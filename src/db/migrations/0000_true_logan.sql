CREATE TABLE "approvals" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"actor_slack_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "approvals_proposal_unique" UNIQUE("tenant_id","proposal_id")
);
--> statement-breakpoint
CREATE TABLE "approvers" (
	"tenant_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvers_tenant_id_slack_user_id_pk" PRIMARY KEY("tenant_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "audit" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"actor_slack_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"payload_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "channel_mappings" (
	"tenant_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"installation_id" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_mappings_tenant_id_channel_id_pk" PRIMARY KEY("tenant_id","channel_id"),
	CONSTRAINT "channel_mappings_repository_unique" UNIQUE("tenant_id","channel_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "identity_mappings" (
	"tenant_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_mappings_tenant_id_slack_user_id_pk" PRIMARY KEY("tenant_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"slack_event_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"message_ts" text NOT NULL,
	"actor_slack_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "inbox_event_unique" UNIQUE("tenant_id","slack_event_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"state" text DEFAULT 'READY' NOT NULL,
	"fencing_token" integer DEFAULT 0 NOT NULL,
	"owner_attempt_id" text,
	"lease_expires_at" timestamp with time zone,
	"result_external_id" text,
	"result_external_url" text,
	"error_code" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "operations_proposal_unique" UNIQUE("tenant_id","proposal_id"),
	CONSTRAINT "operations_state_check" CHECK ("operations"."state" in ('READY','SENDING','SUCCEEDED','FAILED','UNKNOWN','STALE'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"task_id" text NOT NULL,
	"inbox_id" text,
	"proposal_id" text,
	"operation_id" text,
	"dispatch_state" text DEFAULT 'PENDING' NOT NULL,
	"execution_state" text DEFAULT 'READY' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"trigger_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "outbox_one_entity_check" CHECK (num_nonnulls("outbox"."inbox_id", "outbox"."proposal_id", "outbox"."operation_id") = 1),
	CONSTRAINT "outbox_dispatch_state_check" CHECK ("outbox"."dispatch_state" in ('PENDING','CLAIMED','DISPATCHED')),
	CONSTRAINT "outbox_execution_state_check" CHECK ("outbox"."execution_state" in ('READY','RUNNING','SUCCEEDED','FAILED','BLOCKED'))
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"thread_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"version" integer NOT NULL,
	"mutation" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"action_fingerprint" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "proposals_fingerprint_unique" UNIQUE("tenant_id","action_fingerprint"),
	CONSTRAINT "proposals_operation_unique" UNIQUE("tenant_id","operation_id"),
	CONSTRAINT "proposals_state_check" CHECK ("proposals"."state" in ('PENDING','APPROVED','DISMISSED','SUPERSEDED','EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"thread_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "snapshots_hash_unique" UNIQUE("tenant_id","snapshot_hash")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_id_pk" PRIMARY KEY("id"),
	CONSTRAINT "tenants_slack_team_unique" UNIQUE("slack_team_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"linked_issue_id" text,
	"linked_issue_number" integer,
	"active_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "threads_coordinate_unique" UNIQUE("tenant_id","channel_id","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvers" ADD CONSTRAINT "approvers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_mappings" ADD CONSTRAINT "identity_mappings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_channel_mapping_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channel_mappings"("tenant_id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_inbox_fk" FOREIGN KEY ("tenant_id","inbox_id") REFERENCES "public"."inbox"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."threads"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_snapshot_fk" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "public"."snapshots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."threads"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_mapping_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channel_mappings"("tenant_id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_active_thread_unique" ON "proposals" USING btree ("tenant_id","thread_id") WHERE "proposals"."state" in ('PENDING','APPROVED');