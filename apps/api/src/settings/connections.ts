import { connectableForgeSchema, type ConnectableForge, type Connection } from "@issue-pipeline/shared";
import { HttpError } from "../http";
import type { UserIdentityRow } from "../db/schema";

/** A `:forge` route parameter, or a 404. */
export function requireConnectableForge(value: string | undefined): ConnectableForge {
  const parsed = connectableForgeSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("not_found", "Unknown forge.");
  return parsed.data;
}

/** The linked identity as the browser sees it: never the stored Gitea token. */
export function toConnectionDto(row: UserIdentityRow): Connection {
  return {
    forge: row.forge as ConnectableForge,
    username: row.username,
    linked_at: row.updatedAt.toISOString(),
    repo_access: row.accessTokenEnc !== null,
  };
}
