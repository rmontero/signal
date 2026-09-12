ALTER TABLE "approvals" DROP CONSTRAINT "approvals_operation_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_operation_fk" FOREIGN KEY ("tenant_id","operation_id","proposal_id") REFERENCES "public"."operations"("tenant_id","id","proposal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_identity_unique" UNIQUE("tenant_id","id","proposal_id");