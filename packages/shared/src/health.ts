import { z } from "zod";

export const healthResponseSchema = z.object({
  db: z.enum(["ok", "error"]),
  /** Server time, so a client can spot a badly skewed clock. */
  now: z.iso.datetime(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
