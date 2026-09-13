CREATE TABLE "tenant_memberships" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"auth0_subject" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "tenant_memberships_subject_unique" UNIQUE("tenant_id","auth0_subject"),
	CONSTRAINT "tenant_memberships_role_check" CHECK ("tenant_memberships"."role" in ('OWNER','ADMIN','MEMBER')),
	CONSTRAINT "tenant_memberships_subject_check" CHECK ("tenant_memberships"."auth0_subject" collate "C" ~ '^[!-~]{1,255}$')
);
--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "slack_team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "display_name" text DEFAULT 'My workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_memberships_subject_lookup" ON "tenant_memberships" USING btree ("auth0_subject");
