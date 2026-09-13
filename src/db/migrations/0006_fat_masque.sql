DROP INDEX "proposals_active_thread_unique";--> statement-breakpoint
ALTER TABLE "approvers" DROP CONSTRAINT "approvers_tenant_id_slack_user_id_pk";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "modal_id" text;--> statement-breakpoint
ALTER TABLE "approvers" ADD COLUMN "channel_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approvers" ADD CONSTRAINT "approvers_tenant_id_channel_id_slack_user_id_pk" PRIMARY KEY("tenant_id","channel_id","slack_user_id");--> statement-breakpoint
ALTER TABLE "approvers" ADD CONSTRAINT "approvers_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channel_mappings"("tenant_id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_active_thread_unique" ON "proposals" USING btree ("tenant_id","thread_id") WHERE "proposals"."state" = 'PENDING';--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_thread_version_unique" UNIQUE("tenant_id","thread_id","version");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_notification_state_check" CHECK ("proposals"."notification_state" in ('PENDING','SENDING','SENT','UNKNOWN'));
