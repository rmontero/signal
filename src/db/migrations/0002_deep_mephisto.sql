CREATE TABLE "observed_events" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"channel_id" text,
	"thread_ts" text,
	"message_ts" text,
	"actor_id" text,
	"repository_id" text,
	"repository_owner" text,
	"repository_name" text,
	"installation_id" text,
	"pull_request_number" integer,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observed_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "observed_events_provider_unique" UNIQUE("tenant_id","source","provider_event_id"),
	CONSTRAINT "observed_events_source_check" CHECK ("observed_events"."source" in ('slack','github'))
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_one_entity_check";--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "observer_event_id" text;--> statement-breakpoint
ALTER TABLE "observed_events" ADD CONSTRAINT "observed_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_observer_event_fk" FOREIGN KEY ("tenant_id","observer_event_id") REFERENCES "public"."observed_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_one_entity_check" CHECK (num_nonnulls("outbox"."inbox_id", "outbox"."proposal_id", "outbox"."operation_id", "outbox"."observer_event_id") = 1);