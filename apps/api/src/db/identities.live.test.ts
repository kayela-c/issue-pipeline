import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Linked identities against the real database in DATABASE_URL (the Neon dev
 * branch). Opt-in: LIVE_DB=1 pnpm --filter @issue-pipeline/api test
 */
const live = process.env.LIVE_DB === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && !process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("identities store (live database)", async () => {
  const { getDb, schema } = await import("./client");
  const identities = await import("./identities");

  const suffix = randomUUID().slice(0, 8);
  const ids = { userA: "", userB: "" };

  beforeAll(async () => {
    const [a, b] = await getDb()
      .insert(schema.users)
      .values([
        { giteaId: -randomInt(1, 2 ** 31), username: `live-test-a-${suffix}` },
        { giteaId: -randomInt(1, 2 ** 31), username: `live-test-b-${suffix}` },
      ])
      .returning();
    ids.userA = a!.id;
    ids.userB = b!.id;
  });

  afterAll(async () => {
    for (const userId of [ids.userA, ids.userB]) {
      if (userId) await getDb().delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  it("links, finds by forge user, and re-linking updates the same row", async () => {
    await identities.upsertIdentity({
      userId: ids.userA,
      forge: "github",
      forgeUserId: `gh-${suffix}`,
      username: "kayela-c",
      giteaRefreshTokenEnc: "v1.sealed-one",
    });

    const found = await identities.findIdentityByForgeUser("github", `gh-${suffix}`);
    expect(found).toMatchObject({ userId: ids.userA, username: "kayela-c", giteaRefreshTokenEnc: "v1.sealed-one" });

    // Re-linking the same (user, forge) updates in place rather than erroring.
    await identities.upsertIdentity({
      userId: ids.userA,
      forge: "github",
      forgeUserId: `gh-${suffix}`,
      username: "kayela-c-renamed",
      giteaRefreshTokenEnc: "v1.sealed-two",
    });
    expect(await identities.getIdentity(ids.userA, "github")).toMatchObject({ username: "kayela-c-renamed" });

    const rows = await identities.listIdentities(ids.userA);
    expect(rows).toHaveLength(1);
  });

  it("refuses linking the same forge account to a second user", async () => {
    await identities.upsertIdentity({
      userId: ids.userA,
      forge: "gitlab",
      forgeUserId: `gl-${suffix}`,
      username: "kayela",
      giteaRefreshTokenEnc: "v1.sealed",
    });
    await expect(
      identities.upsertIdentity({
        userId: ids.userB,
        forge: "gitlab",
        forgeUserId: `gl-${suffix}`,
        username: "someone-else",
        giteaRefreshTokenEnc: "v1.sealed",
      }),
    ).rejects.toBeInstanceOf(identities.IdentityLinkedElsewhere);
  });

  it("touches only the token, and delete removes the row", async () => {
    await identities.upsertIdentity({
      userId: ids.userB,
      forge: "github",
      forgeUserId: `gh-b-${suffix}`,
      username: "b-user",
      giteaRefreshTokenEnc: "v1.original",
    });
    await identities.touchIdentityToken(ids.userB, "github", "v1.rotated");
    expect(await identities.getIdentity(ids.userB, "github")).toMatchObject({ username: "b-user", giteaRefreshTokenEnc: "v1.rotated" });

    expect(await identities.deleteIdentity(ids.userB, "github")).toBe(true);
    expect(await identities.getIdentity(ids.userB, "github")).toBeUndefined();
    expect(await identities.deleteIdentity(ids.userB, "github")).toBe(false);
  });
});
