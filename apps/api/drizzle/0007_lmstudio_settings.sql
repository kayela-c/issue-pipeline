ALTER TABLE "user_ai_providers" DROP CONSTRAINT "user_ai_providers_provider_check";--> statement-breakpoint
ALTER TABLE "user_ai_settings" DROP CONSTRAINT "user_ai_settings_provider_check";--> statement-breakpoint
ALTER TABLE "user_ai_providers" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "user_ai_providers" ADD COLUMN "context_tokens" integer;--> statement-breakpoint
ALTER TABLE "user_ai_providers" ADD CONSTRAINT "user_ai_providers_provider_check" CHECK ("user_ai_providers"."provider" IN ('anthropic', 'gemini', 'grok', 'openai', 'venice', 'lmstudio'));--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_provider_check" CHECK ("user_ai_settings"."provider" IS NULL OR "user_ai_settings"."provider" IN ('anthropic', 'gemini', 'grok', 'openai', 'venice', 'lmstudio'));