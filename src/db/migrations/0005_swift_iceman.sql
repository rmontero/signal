ALTER TABLE "operations" ADD COLUMN "result_assignees" jsonb;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "assignee_mismatch" boolean;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "execution_owner_run_id" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "execution_fencing_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "execution_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "retry_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "notification_message_ts" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "notification_state" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "analysis" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "config_version" integer DEFAULT 0 NOT NULL;
