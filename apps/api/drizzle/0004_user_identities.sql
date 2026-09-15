CREATE TABLE "user_identities" (
	"user_id" uuid NOT NULL,
	"forge" text NOT NULL,
	"forge_user_id" text NOT NULL,
	"username" text NOT NULL,
	"gitea_refresh_token_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_user_id_forge_pk" PRIMARY KEY("user_id","forge"),
	CONSTRAINT "user_identities_forge_user_key" UNIQUE("forge","forge_user_id"),
	CONSTRAINT "user_identities_forge_check" CHECK ("user_identities"."forge" IN ('github', 'gitlab', 'bitbucket'))
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;