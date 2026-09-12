CREATE TABLE "slack_reviews" (
	"tenant_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"modal_id" text NOT NULL,
	"actor_slack_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_reviews_tenant_id_proposal_id_modal_id_pk" PRIMARY KEY("tenant_id","proposal_id","modal_id")
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "notification_message_ts" text;--> statement-breakpoint
ALTER TABLE "slack_reviews" ADD CONSTRAINT "slack_reviews_proposal_fk" FOREIGN KEY ("tenant_id","proposal_id") REFERENCES "public"."proposals"("tenant_id","id") ON DELETE no action ON UPDATE no action;