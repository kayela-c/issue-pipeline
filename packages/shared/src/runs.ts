import { z } from "zod";
import { draftStatusSchema, runStatusSchema } from "./enums.js";

export const RAW_ISSUE_MAX_LENGTH = 20_000;

export const createRawIssueRequestSchema = z.object({
  repo_id: z.uuid(),
  body: z.string().trim().min(1, "Describe the issue").max(RAW_ISSUE_MAX_LENGTH),
  /** An app template (Settings > Templates) to draft with instead of the repository's own templates. */
  template_id: z.uuid().nullable().optional(),
});
export type CreateRawIssueRequest = z.infer<typeof createRawIssueRequestSchema>;

export const createRawIssueResponseSchema = z.object({ run_id: z.uuid() });
export type CreateRawIssueResponse = z.infer<typeof createRawIssueResponseSchema>;

const timestamp = z.iso.datetime({ offset: true });

export const runResponseSchema = z.object({
  id: z.uuid(),
  repo_id: z.uuid(),
  status: runStatusSchema,
  error: z.string().nullable(),
  attempts: z.number().int(),
  commit_sha: z.string().nullable(),
  raw_issue: z.string(),
  draft_ids: z.array(z.uuid()),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  /** "provider/model" used for drafting, once the run is done. */
  model_draft: z.string().nullable(),
  /** The app template the run drafted with, as it was when submitted; null for the repository's own templates. */
  app_template: z.object({ name: z.string(), file: z.string(), kind: z.string() }).nullable(),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

/** One row of the workflow queue: a submission and where its drafts stand. */
export const runSummarySchema = z.object({
  id: z.uuid(),
  status: runStatusSchema,
  error: z.string().nullable(),
  attempts: z.number().int(),
  repo: z.object({ id: z.uuid(), owner: z.string(), name: z.string() }),
  author: z.object({ username: z.string(), display_name: z.string().nullable() }),
  /** The start of the submitted notes. */
  excerpt: z.string(),
  /** Drafts produced by the run, counted by draft status. */
  drafts: z.partialRecord(draftStatusSchema, z.number().int()),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runListResponseSchema = z.object({ runs: z.array(runSummarySchema) });
export type RunListResponse = z.infer<typeof runListResponseSchema>;
