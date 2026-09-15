import { and, eq, isNull, sql } from "drizzle-orm";
import type { ForgeUser } from "../forge/types";
import { getDb, schema } from "./client";

export type User = typeof schema.users.$inferSelect;

/** Postgres unique_violation, wherever the driver or Drizzle put the code. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return true;
  }
  return false;
}

export class GiteaLinkedElsewhere extends Error {
  constructor() {
    super("This Gitea account is already linked to a different sign-in.");
    this.name = "GiteaLinkedElsewhere";
  }
}

export async function getUserById(id: string): Promise<User | undefined> {
  const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  return row;
}

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

/** A brand-new account with no Gitea link yet, created by a non-Gitea sign-in (decision 22). */
export async function createUnlinkedUser(input: { username: string; displayName: string | null }): Promise<User> {
  const [row] = await getDb()
    .insert(schema.users)
    .values({ giteaId: null, username: input.username, displayName: input.displayName })
    .returning();
  if (!row) {
    throw new Error("user insert returned no row");
  }
  return row;
}

/**
 * Attach a Gitea identity to an account that does not have one yet -- the
 * reverse of GitHub's link mode, used when a Gitea-less account signs in with
 * Gitea for the first time. Throws GiteaLinkedElsewhere if that Gitea account
 * is already linked to a different user; idempotent if this user already has
 * this exact link.
 */
export async function linkGiteaToUser(userId: string, forgeUser: ForgeUser): Promise<User> {
  try {
    const [row] = await getDb()
      .update(schema.users)
      .set({
        giteaId: forgeUser.id,
        username: forgeUser.username,
        displayName: forgeUser.fullName ?? null,
        lastSeenAt: sql`now()`,
      })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.giteaId)))
      .returning();
    if (row) return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new GiteaLinkedElsewhere();
    throw err;
  }
  // No row updated: this user already has a gitea_id. Treat a repeat of the
  // same link as a no-op; anything else is a bug in the caller.
  const existing = await getUserById(userId);
  if (!existing) throw new Error("user not found");
  return existing;
}
