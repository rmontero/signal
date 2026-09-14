CREATE TABLE "oauth_states" (
	"tenant_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"auth0_subject" text NOT NULL,
	"provider" text NOT NULL,
	"return_to" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_tenant_id_state_hash_pk" PRIMARY KEY("tenant_id","state_hash"),
	CONSTRAINT "oauth_states_provider_check" CHECK ("oauth_states"."provider" in ('github','slack')),
	CONSTRAINT "oauth_states_hash_check" CHECK ("oauth_states"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_states_expiry_check" CHECK ("oauth_states"."expires_at" > "oauth_states"."created_at"),
	CONSTRAINT "oauth_states_return_to_check" CHECK (length("oauth_states"."return_to") between 1 and 2048 and left("oauth_states"."return_to", 1) = '/' and left("oauth_states"."return_to", 2) <> '//')
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"installation_id" text,
	"bot_user_id" text,
	"display_name" text NOT NULL,
	"encrypted_secret" text,
	"scopes" jsonb NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"connected_by_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_connections_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "provider_connections_provider_unique" UNIQUE("tenant_id","provider"),
	CONSTRAINT "provider_connections_provider_check" CHECK ("provider_connections"."provider" in ('github','slack')),
	CONSTRAINT "provider_connections_status_check" CHECK ("provider_connections"."status" in ('ACTIVE','REVOKED')),
	CONSTRAINT "provider_connections_account_check" CHECK ("provider_connections"."external_account_id" collate "C" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "provider_connections_scopes_check" CHECK (jsonb_typeof("provider_connections"."scopes") = 'array'),
	CONSTRAINT "provider_connections_identity_check" CHECK (("provider_connections"."provider" = 'github' and "provider_connections"."installation_id" is not null and "provider_connections"."installation_id" collate "C" ~ '^[!-~]{1,255}$' and "provider_connections"."bot_user_id" is null and "provider_connections"."encrypted_secret" is null) or ("provider_connections"."provider" = 'slack' and "provider_connections"."installation_id" is null and "provider_connections"."bot_user_id" is not null and "provider_connections"."bot_user_id" collate "C" ~ '^[!-~]{1,255}$' and ("provider_connections"."status" = 'REVOKED' or "provider_connections"."encrypted_secret" is not null))),
	CONSTRAINT "provider_connections_revoked_check" CHECK (("provider_connections"."status" = 'ACTIVE' and "provider_connections"."revoked_at" is null) or ("provider_connections"."status" = 'REVOKED' and "provider_connections"."revoked_at" is not null and "provider_connections"."encrypted_secret" is null))
);
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_membership_fk" FOREIGN KEY ("tenant_id","auth0_subject") REFERENCES "public"."tenant_memberships"("tenant_id","auth0_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_membership_fk" FOREIGN KEY ("tenant_id","connected_by_subject") REFERENCES "public"."tenant_memberships"("tenant_id","auth0_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_expiry_lookup" ON "oauth_states" USING btree ("tenant_id","expires_at");