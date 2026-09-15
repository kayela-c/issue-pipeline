import { z } from "zod";

/**
 * GET /api/me -- the signed-in user as the API sees them. `gitea_id` is null
 * for an account created by GitHub sign-in that has not linked Gitea yet
 * (decision 22) -- every tracked repo needs Gitea, so the app shows a
 * "connect Gitea" screen instead of the normal one in that case.
 */
export const meResponseSchema = z.object({
  id: z.uuid(),
  gitea_id: z.number().int().nullable(),
  username: z.string(),
  display_name: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
