CREATE TABLE "user_ai_providers" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model_select" text,
	"model_draft" text,
	"api_key_enc" text,
	"api_key_last4" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_providers_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "user_ai_providers_provider_check" CHECK ("user_ai_providers"."provider" IN ('anthropic', 'gemini', 'grok', 'openai', 'venice'))
);
--> statement-breakpoint
CREATE TABLE "user_ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_settings_provider_check" CHECK ("user_ai_settings"."provider" IS NULL OR "user_ai_settings"."provider" IN ('anthropic', 'gemini', 'grok', 'openai', 'venice'))
);
--> statement-breakpoint
ALTER TABLE "user_ai_providers" ADD CONSTRAINT "user_ai_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;