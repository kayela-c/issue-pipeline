import { z } from "zod";

/**
 * Domain enums. These mirror the CHECK constraints in the database schema
 * (docs/ARCHITECTURE.md section 4). Text + CHECK rather than PG enums, so
 * extending a status is a migration on the constraint, not on a type.
 */

export const RUN_STATUSES = [
  "queued",
  "reading_repo",
  "selecting_files",
  "drafting",
  "done",
  "failed",
] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** A run is finished when it will not advance again without an explicit retry. */
export const TERMINAL_RUN_STATUSES = ["done", "failed"] as const satisfies readonly RunStatus[];

export const isTerminalRunStatus = (status: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);

export const DRAFT_STATUSES = [
  "draft",
  "approved",
  "posting",
  "posted",
  "failed",
] as const;

export const draftStatusSchema = z.enum(DRAFT_STATUSES);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

export const DRAFT_EVENTS = [
  "created",
  "edited",
  "deps_changed",
  "approved",
  "unapproved",
  "claimed",
  "posted",
  "failed",
  "reconciled",
  "link_failed",
] as const;

export const draftEventSchema = z.enum(DRAFT_EVENTS);
export type DraftEvent = z.infer<typeof draftEventSchema>;
