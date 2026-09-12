ALTER TABLE "observed_events" ADD COLUMN "classification_state" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "observed_events" ADD COLUMN "classification_reason" text;--> statement-breakpoint
ALTER TABLE "observed_events" ADD COLUMN "evidence_refs" jsonb;--> statement-breakpoint
ALTER TABLE "observed_events" ADD CONSTRAINT "observed_events_classification_check" CHECK ("observed_events"."classification_state" in ('PENDING','SIGNAL','NOISE','BLOCKED'));