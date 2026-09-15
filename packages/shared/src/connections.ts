import { z } from "zod";
import { type Forge } from "./templates.js";

/**
 * Forges a user can link as an alternate sign-in, beyond the Gitea account
 * that creates their app account. See docs/ARCHITECTURE.md section 5.
 */
export const CONNECTABLE_FORGES = ["github", "gitlab", "bitbucket"] as const;
export type ConnectableForge = (typeof CONNECTABLE_FORGES)[number];
export const connectableForgeSchema = z.enum(CONNECTABLE_FORGES);

export const CONNECTABLE_FORGE_STATUS: Record<ConnectableForge, "available" | "coming_soon"> = {
  github: "available",
  gitlab: "coming_soon",
  bitbucket: "coming_soon",
};

/** GET /api/settings/connections -- forges linked to the caller's account. */
export const connectionSchema = z.object({
  forge: connectableForgeSchema,
  username: z.string(),
  linked_at: z.string(),
  /** Whether the app holds a token that can read and post to this forge's repositories (GitHub: the `repo` scope). */
  repo_access: z.boolean(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionsResponseSchema = z.object({ connections: z.array(connectionSchema) });
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;

/** True when `forge` isn't `gitea` -- the only forge that can be linked, not just used. */
export const isConnectableForge = (forge: Forge): forge is ConnectableForge =>
  (CONNECTABLE_FORGES as readonly string[]).includes(forge);
