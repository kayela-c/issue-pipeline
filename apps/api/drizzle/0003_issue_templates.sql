CREATE TABLE "issue_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"forges" text[] NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_templates_name_key" UNIQUE("name"),
	CONSTRAINT "issue_templates_name_len" CHECK (length("issue_templates"."name") BETWEEN 1 AND 100),
	CONSTRAINT "issue_templates_kind_check" CHECK ("issue_templates"."kind" IN ('markdown', 'form')),
	CONSTRAINT "issue_templates_forges_check" CHECK (cardinality("issue_templates"."forges") > 0 AND "issue_templates"."forges" <@ ARRAY['gitea', 'github', 'gitlab', 'bitbucket']::text[]),
	CONSTRAINT "issue_templates_content_len" CHECK (length("issue_templates"."content") BETWEEN 1 AND 50000)
);
--> statement-breakpoint
ALTER TABLE "raw_issues" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "template_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_issues" ADD CONSTRAINT "raw_issues_template_id_issue_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."issue_templates"("id") ON DELETE set null ON UPDATE no action;