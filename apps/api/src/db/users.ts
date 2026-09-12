import { sql } from "drizzle-orm";
import type { ForgeUser } from "../forge/types";
import { getDb, schema } from "./client";

export type User = typeof schema.users.$inferSelect;

/** Insert or refresh the user row for a Gitea identity; bumps last_seen_at. */
export async function upsertUser(forgeUser: ForgeUser): Promise<User> {
  const values = {
    giteaId: forgeUser.id,
    username: forgeUser.username,
    displayName: forgeUser.fullName ?? null,
  };
  const [row] = await getDb()
    .insert(schema.users)
    .values(values)
    .onConflictDoUpdate({
      target: schema.users.giteaId,
      set: {
        username: values.username,
        displayName: values.displayName,
        lastSeenAt: sql`now()`,
      },
    })
    .returning();
  if (!row) {
    throw new Error("user upsert returned no row");
  }
  return row;
}
