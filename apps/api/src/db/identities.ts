import type { ConnectableForge } from "@issue-pipeline/shared";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./client";
import type { UserIdentityRow } from "./schema";

/** Postgres unique_violation, wherever the driver or Drizzle put the code. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return true;
  }
  return false;
}

export class IdentityLinkedElsewhere extends Error {
  constructor(forge: ConnectableForge) {
    super(`This ${forge} account is already linked to a different sign-in.`);
    this.name = "IdentityLinkedElsewhere";
  }
}

export async function listIdentities(userId: string): Promise<UserIdentityRow[]> {
  return getDb().select().from(schema.userIdentities).where(eq(schema.userIdentities.userId, userId));
}

export async function getIdentity(userId: string, forge: ConnectableForge): Promise<UserIdentityRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.forge, forge)));
  return row;
}

export async function findIdentityByForgeUser(
  forge: ConnectableForge,
  forgeUserId: string,
): Promise<UserIdentityRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(schema.userIdentities)
    .where(and(eq(schema.userIdentities.forge, forge), eq(schema.userIdentities.forgeUserId, forgeUserId)));
  return row;
}

/**
 * Link a forge identity to a user, storing the Gitea refresh token snapshot
 * that a future sign-in through this identity will use to mint a Gitea
 * session -- null when the account has no Gitea link at all yet, in which
 * case a future sign-in through this identity signs straight in, Gitea-less.
 * Throws IdentityLinkedElsewhere if the forge account is already linked to
 * someone else; updates in place (including re-linking after an unlink)
 * otherwise.
 */
export async function upsertIdentity(input: {
  userId: string;
  forge: ConnectableForge;
  forgeUserId: string;
  username: string;
  giteaRefreshTokenEnc: string | null;
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.userIdentities)
      .values(input)
      .onConflictDoUpdate({
        target: [schema.userIdentities.userId, schema.userIdentities.forge],
        set: {
          forgeUserId: input.forgeUserId,
          username: input.username,
          giteaRefreshTokenEnc: input.giteaRefreshTokenEnc,
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    if (isUniqueViolation(err)) throw new IdentityLinkedElsewhere(input.forge);
    throw err;
  }
}

/** Refresh the stored Gitea token snapshot after a sign-in rotates it, without touching identity fields. */
export async function touchIdentityToken(userId: string, forge: ConnectableForge, giteaRefreshTokenEnc: string): Promise<void> {
  await getDb()
    .update(schema.userIdentities)
    .set({ giteaRefreshTokenEnc, updatedAt: sql`now()` })
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.forge, forge)));
}

/** Store the forge access token a fresh sign-in just received (null when it lacks repo access). */
export async function setIdentityAccessToken(userId: string, forge: ConnectableForge, accessTokenEnc: string | null): Promise<void> {
  await getDb()
    .update(schema.userIdentities)
    .set({ accessTokenEnc, updatedAt: sql`now()` })
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.forge, forge)));
}

export async function deleteIdentity(userId: string, forge: ConnectableForge): Promise<boolean> {
  const rows = await getDb()
    .delete(schema.userIdentities)
    .where(and(eq(schema.userIdentities.userId, userId), eq(schema.userIdentities.forge, forge)))
    .returning({ userId: schema.userIdentities.userId });
  return rows.length > 0;
}
