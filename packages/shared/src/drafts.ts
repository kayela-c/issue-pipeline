import { z } from "zod";
import { draftStatusSchema } from "./enums.js";

export const draftSchema = z.object({
  id: z.uuid(),
  run_id: z.uuid().nullable(),
  repo_id: z.uuid(),
  title: z.string(),
  body: z.string(),
  template_name: z.string().nullable(),
  labels: z.array(z.string()),
  status: draftStatusSchema,
  version: z.number().int(),
  depends_on: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      gitea_number: z.number().int().nullable(),
    }),
  ),
  gitea_number: z.number().int().nullable(),
  gitea_url: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Draft = z.infer<typeof draftSchema>;

export const draftListResponseSchema = z.object({ drafts: z.array(draftSchema) });
export type DraftListResponse = z.infer<typeof draftListResponseSchema>;
