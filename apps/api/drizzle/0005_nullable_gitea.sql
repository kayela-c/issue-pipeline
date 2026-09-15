ALTER TABLE "user_identities" ALTER COLUMN "gitea_refresh_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "gitea_id" DROP NOT NULL;