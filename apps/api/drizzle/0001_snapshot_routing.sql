ALTER TABLE "repo_snapshots" ADD COLUMN "routing" text;--> statement-breakpoint
-- Snapshots are a disposable cache keyed by commit. Ones written before this
-- column existed never looked for ROUTING.md, so drop them to be re-read.
DELETE FROM "repo_snapshots";
