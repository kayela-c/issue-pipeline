import { z } from "zod";
import { draftEventSchema, draftStatusSchema } from "./enums.js";
import { repoForgeSchema } from "./repos.js";

const timestamp = z.iso.datetime({ offset: true });

/** A draft another draft points at (a dependency or a dependent). */
export const draftRefSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: draftStatusSchema,
  gitea_number: z.number().int().nullable(),
});
export type DraftRef = z.infer<typeof draftRefSchema>;

export const draftSchema = z.object({
  id: z.uuid(),
  run_id: z.uuid().nullable(),
  repo_id: z.uuid(),
  repo: z.object({ forge: repoForgeSchema, owner: z.string(), name: z.string() }),
  title: z.string(),
  body: z.string(),
  template_name: z.string().nullable(),
  labels: z.array(z.string()),
  status: draftStatusSchema,
  /** Optimistic-concurrency token: send it back with every change. */
  version: z.number().int(),
  depends_on: z.array(draftRefSchema),
  created_by: z.string(),
  approved_by: z.string().nullable(),
  /** The posted issue's number and URL on the repo's forge (named for Gitea, which came first). */
  gitea_number: z.number().int().nullable(),
  gitea_url: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type Draft = z.infer<typeof draftSchema>;

export const draftListResponseSchema = z.object({ drafts: z.array(draftSchema) });
export type DraftListResponse = z.infer<typeof draftListResponseSchema>;

export const draftEventItemSchema = z.object({
  id: z.number().int(),
  event: draftEventSchema,
  actor: z.string().nullable(),
  detail: z.unknown(),
  created_at: timestamp,
});
export type DraftEventItem = z.infer<typeof draftEventItemSchema>;

/** GET /api/drafts/:id */
export const draftDetailSchema = draftSchema.extend({
  /** Drafts that depend on this one. */
  dependents: z.array(draftRefSchema),
  events: z.array(draftEventItemSchema),
});
export type DraftDetail = z.infer<typeof draftDetailSchema>;

export const DRAFT_TITLE_MAX = 255;
export const DRAFT_BODY_MAX = 60_000;
export const DRAFT_LABELS_MAX = 50;
export const DRAFT_DEPS_MAX = 20;

/** PATCH /api/drafts/:id -- only while status is "draft". */
export const updateDraftRequestSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(DRAFT_TITLE_MAX).optional(),
    body: z.string().max(DRAFT_BODY_MAX).optional(),
    labels: z.array(z.string().min(1).max(100)).max(DRAFT_LABELS_MAX).optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => v.title !== undefined || v.body !== undefined || v.labels !== undefined, "Nothing to change");
export type UpdateDraftRequest = z.infer<typeof updateDraftRequestSchema>;

/** PUT /api/drafts/:id/deps -- replaces the dependency set. */
export const updateDepsRequestSchema = z.object({
  depends_on_ids: z.array(z.uuid()).max(DRAFT_DEPS_MAX),
  version: z.number().int().positive(),
});
export type UpdateDepsRequest = z.infer<typeof updateDepsRequestSchema>;

/** POST /api/drafts/:id/approve -- the version the approver reviewed. */
export const approveDraftRequestSchema = z.object({ version: z.number().int().positive() });
export type ApproveDraftRequest = z.infer<typeof approveDraftRequestSchema>;

export const repoLabelsResponseSchema = z.object({
  labels: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
export type RepoLabelsResponse = z.infer<typeof repoLabelsResponseSchema>;
