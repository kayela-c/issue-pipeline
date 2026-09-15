import { z } from "zod";

/** Forges a repo can be tracked on today (Phase 9: GitHub alongside Gitea). */
export const REPO_FORGES = ["gitea", "github"] as const;
export const repoForgeSchema = z.enum(REPO_FORGES);
export type RepoForge = z.infer<typeof repoForgeSchema>;

/** A repo tracked by the pipeline. */
export const repoSchema = z.object({
  id: z.uuid(),
  forge: repoForgeSchema,
  owner: z.string(),
  name: z.string(),
  default_branch: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Repo = z.infer<typeof repoSchema>;

export const repoListResponseSchema = z.object({ repos: z.array(repoSchema) });
export type RepoListResponse = z.infer<typeof repoListResponseSchema>;

/** A repo the signed-in user can see on a forge (for the "track a repo" picker). */
export const giteaRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  full_name: z.string(),
  description: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  has_issues: z.boolean(),
});
export type GiteaRepo = z.infer<typeof giteaRepoSchema>;

export const giteaRepoListResponseSchema = z.object({ repos: z.array(giteaRepoSchema) });
export type GiteaRepoListResponse = z.infer<typeof giteaRepoListResponseSchema>;

// Gitea and GitHub owner and repo names: letters, digits, '-', '_', '.'.
const giteaName = z.string().min(1).max(100).regex(/^[\w.-]+$/, "invalid name");

export const trackRepoRequestSchema = z.object({
  forge: repoForgeSchema.default("gitea"),
  owner: giteaName,
  name: giteaName,
});
export type TrackRepoRequest = z.infer<typeof trackRepoRequestSchema>;
