import { z } from "zod";

/** GET /api/me -- the signed-in user as the API sees them. */
export const meResponseSchema = z.object({
  id: z.uuid(),
  gitea_id: z.number().int(),
  username: z.string(),
  display_name: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
