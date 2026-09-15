ALTER TABLE "repos" DROP CONSTRAINT "repos_owner_name_key";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "forge" text DEFAULT 'gitea' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "access_token_enc" text;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_forge_owner_name_key" UNIQUE("forge","owner","name");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_forge_check" CHECK ("repos"."forge" IN ('gitea', 'github'));