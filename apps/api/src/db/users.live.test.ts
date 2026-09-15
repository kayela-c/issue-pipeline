import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Nullable gitea_id and account linking (decision 22) against the real
 * database in DATABASE_URL (the Neon dev branch). Opt-in:
 * LIVE_DB=1 pnpm --filter @issue-pipeline/api test
 */
const live = process.env.LIVE_DB === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && !process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("users store: Gitea-less accounts (live database)", async () => {
  const { getDb, schema } = await import("./client");
  const users = await import("./users");

  const suffix = randomUUID().slice(0, 8);
  const ids: string[] = [];
  const giteaIds: number[] = [];

  afterAll(async () => {
    for (const id of ids) await getDb().delete(schema.users).where(eq(schema.users.id, id));
  });

  it("creates an account with no Gitea link, then links Gitea to it", async () => {
    const created = await users.createUnlinkedUser({ username: `live-gh-${suffix}`, displayName: null });
    ids.push(created.id);
    expect(created.giteaId).toBeNull();

    const giteaId = -randomInt(1, 2 ** 31);
    giteaIds.push(giteaId);
    const linked = await users.linkGiteaToUser(created.id, { id: giteaId, username: `live-gitea-${suffix}` });
    expect(linked).toMatchObject({ id: created.id, giteaId, username: `live-gitea-${suffix}` });

    expect(await users.getUserById(created.id)).toMatchObject({ giteaId });
  });

  it("refuses linking a Gitea account already linked to someone else", async () => {
    const giteaId = -randomInt(1, 2 ** 31);
    giteaIds.push(giteaId);
    const owner = await users.upsertUser({ id: giteaId, username: `live-owner-${suffix}` });
    ids.push(owner.id);

    const other = await users.createUnlinkedUser({ username: `live-other-${suffix}`, displayName: null });
    ids.push(other.id);

    await expect(users.linkGiteaToUser(other.id, { id: giteaId, username: `live-owner-${suffix}` })).rejects.toBeInstanceOf(
      users.GiteaLinkedElsewhere,
    );
    // The attempt did not touch the account that was already linked.
    expect(await users.getUserById(owner.id)).toMatchObject({ giteaId });
  });

  it("treats re-linking the same account's own Gitea id as a no-op", async () => {
    const created = await users.createUnlinkedUser({ username: `live-repeat-${suffix}`, displayName: null });
    ids.push(created.id);
    const giteaId = -randomInt(1, 2 ** 31);
    giteaIds.push(giteaId);

    const first = await users.linkGiteaToUser(created.id, { id: giteaId, username: `live-repeat-${suffix}` });
    const second = await users.linkGiteaToUser(created.id, { id: giteaId, username: `live-repeat-${suffix}` });
    expect(second).toMatchObject({ id: first.id, giteaId });
  });
});
