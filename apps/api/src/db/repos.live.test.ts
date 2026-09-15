import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GitHub repos alongside Gitea ones (Phase 9) against the real database in
 * DATABASE_URL (the Neon dev branch). Opt-in: LIVE_DB=1 pnpm --filter @issue-pipeline/api test
 */
const live = process.env.LIVE_DB === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && !process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("repos store: forges (live database)", async () => {
  const { getDb, schema } = await import("./client");
  const repos = await import("./repos");
  const identities = await import("./identities");
  const drafts = await import("./drafts");

  const suffix = randomUUID().slice(0, 8);
  const ids = { user: "", repos: [] as string[] };

  beforeAll(async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ giteaId: -randomInt(1, 2 ** 31), username: `live-gitea-${suffix}` })
      .returning();
    ids.user = user!.id;
  });

  afterAll(async () => {
    for (const id of ids.repos) {
      await getDb().delete(schema.drafts).where(eq(schema.drafts.repoId, id));
      await getDb().delete(schema.repos).where(eq(schema.repos.id, id));
    }
    if (ids.user) await getDb().delete(schema.users).where(eq(schema.users.id, ids.user));
  });

  it("tracks the same owner/name on Gitea and GitHub as two repos, each only once", async () => {
    const input = { owner: "live-test", name: `same-${suffix}`, defaultBranch: "main", addedBy: ids.user };
    const gitea = await repos.trackRepo({ ...input, forge: "gitea" });
    const github = await repos.trackRepo({ ...input, forge: "github" });
    ids.repos.push(gitea.repo.id, github.repo.id);

    expect(gitea).toMatchObject({ created: true, repo: { forge: "gitea" } });
    expect(github).toMatchObject({ created: true, repo: { forge: "github" } });
    expect(github.repo.id).not.toBe(gitea.repo.id);

    const again = await repos.trackRepo({ ...input, forge: "github" });
    expect(again).toMatchObject({ created: false, repo: { id: github.repo.id } });
    expect(repos.toRepoDto(github.repo).forge).toBe("github");
  });

  it("stores and clears a GitHub access token on the identity", async () => {
    await identities.upsertIdentity({
      userId: ids.user,
      forge: "github",
      forgeUserId: `gh-${suffix}`,
      username: `gh-login-${suffix}`,
      giteaRefreshTokenEnc: null,
    });
    await identities.setIdentityAccessToken(ids.user, "github", "v1.sealed-access");
    expect(await identities.getIdentity(ids.user, "github")).toMatchObject({ accessTokenEnc: "v1.sealed-access" });
    await identities.setIdentityAccessToken(ids.user, "github", null);
    expect(await identities.getIdentity(ids.user, "github")).toMatchObject({ accessTokenEnc: null });
  });

  it("reconciles a GitHub repo's draft by the claimer's GitHub login, not their Gitea username", async () => {
    const { repo } = await repos.trackRepo({
      forge: "github",
      owner: "live-test",
      name: `reconcile-${suffix}`,
      defaultBranch: "main",
      addedBy: ids.user,
    });
    ids.repos.push(repo.id);
    const [draft] = await getDb()
      .insert(schema.drafts)
      .values({ repoId: repo.id, createdBy: ids.user, title: "t", body: "b", status: "posting", claimedBy: ids.user, claimedAt: new Date() })
      .returning();

    const ctx = await drafts.getReconcileContext(draft!.id);
    expect(ctx).toMatchObject({ status: "posting", claimedByUsername: `gh-login-${suffix}`, repoOwner: "live-test" });
  });
});
