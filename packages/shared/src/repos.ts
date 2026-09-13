import { z } from "zod";

/** A repo tracked by the pipeline. */
export const repoSchema = z.object({
  id: z.uuid(),
  owner: z.string(),
  name: z.string(),
  default_branch: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Repo = z.infer<typeof repoSchema>;

export const repoListResponseSchema = z.object({ repos: z.array(repoSchema) });
export type RepoListResponse = z.infer<typeof repoListResponseSchema>;

/** A repo the signed-in user can see in Gitea (for the "track a repo" picker). */
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

// Gitea owner and repo names: letters, digits, '-', '_', '.'.
const giteaName = z.string().min(1).max(100).regex(/^[\w.-]+$/, "invalid name");

export const trackRepoRequestSchema = z.object({
  owner: giteaName,
  name: giteaName,
});
export type TrackRepoRequest = z.infer<typeof trackRepoRequestSchema>;
