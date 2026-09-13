import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration test against the real database in DATABASE_URL (the Neon dev
 * branch). Opt-in: LIVE_DB=1 pnpm --filter @issue-pipeline/api test
 *
 * It creates its own user, repo, raw issue, and run, and deletes them after.
 */
const live = process.env.LIVE_DB === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && !process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("runs store (live database)", async () => {
  const { getDb, schema } = await import("./client");
  const runs = await import("./runs");
  const { listDrafts } = await import("./drafts");
  const repos = await import("./repos");

  const ids = { user: "", repo: "", run: "" };

  beforeAll(async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ giteaId: -randomInt(1, 2 ** 31), username: `live-test-${randomUUID().slice(0, 8)}` })
      .returning();
    ids.user = user!.id;
    const { repo } = await repos.trackRepo({
      owner: "live-test",
      name: `repo-${randomUUID().slice(0, 8)}`,
      defaultBranch: "main",
      addedBy: ids.user,
    });
    ids.repo = repo.id;
    ids.run = await runs.createRawIssueWithRun({ repoId: ids.repo, authorId: ids.user, body: "Live test notes" });
  });

  afterAll(async () => {
    if (!ids.repo) return;
    await getDb().delete(schema.drafts).where(eq(schema.drafts.repoId, ids.repo));
    await getDb().delete(schema.rawIssues).where(eq(schema.rawIssues.repoId, ids.repo));
    await getDb().delete(schema.repos).where(eq(schema.repos.id, ids.repo));
    await getDb().delete(schema.users).where(eq(schema.users.id, ids.user));
  });

  const draftsFor = (label: string) => {
    const a = randomUUID();
    const b = randomUUID();
    return [
      { id: a, title: `${label} A`, body: "Body A", template_name: null, labels: ["backend", "api"], depends_on_ids: [] },
      { id: b, title: `${label} B`, body: "Body B", template_name: "task.yml", labels: [], depends_on_ids: [a] },
    ];
  };

  const commit = (drafts: ReturnType<typeof draftsFor>) =>
    runs.commitDrafts({
      runId: ids.run,
      repoId: ids.repo,
      authorId: ids.user,
      drafts,
      reviewerNotes: "notes",
      inputTokens: 1234,
      outputTokens: 567,
      promptVersion: "draftIssues.v1",
      modelSelect: "select-model",
      modelDraft: "draft-model",
    });

  it("claims a queued run once, and not after it is done", async () => {
    const claimed = await runs.claimRun(ids.run);
    expect(claimed).toMatchObject({ run: { status: "reading_repo", attempts: 1 }, rawIssue: { body: "Live test notes" } });
    await runs.setRunProgress(ids.run, "drafting", { commitSha: "abc123" });
  });

  it("commits drafts, deps, and events atomically, exactly once", async () => {
    const first = draftsFor("first");
    expect(await commit(first)).toBe(true);

    // A duplicate or late invocation with different drafts writes nothing.
    expect(await commit(draftsFor("duplicate"))).toBe(false);

    const details = await runs.getRunDetails(ids.run);
    expect(details?.run).toMatchObject({ status: "done", inputTokens: 1234, outputTokens: 567, promptVersion: "draftIssues.v1" });
    expect(details?.draftIds.sort()).toEqual(first.map((d) => d.id).sort());

    const listed = await listDrafts({ runId: ids.run });
    expect(listed.map((d) => d.title).sort()).toEqual(["first A", "first B"]);
    const b = listed.find((d) => d.title === "first B")!;
    expect(b.depends_on).toEqual([{ id: first[0]!.id, title: "first A", gitea_number: null }]);
    expect(listed.find((d) => d.title === "first A")!.labels).toEqual(["backend", "api"]);

    const events = await getDb().select().from(schema.draftEvents).where(inArray(schema.draftEvents.draftId, first.map((d) => d.id)));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "created", actorId: ids.user, detail: { run_id: ids.run, reviewer_notes: "notes" } });

    expect(await runs.claimRun(ids.run)).toBeUndefined();
  });

  it("lists the run in the queue with its draft counts", async () => {
    const queue = await runs.listRuns(200);
    expect(queue.find((r) => r.id === ids.run)).toMatchObject({
      status: "done",
      repo: { id: ids.repo, owner: "live-test" },
      excerpt: "Live test notes",
      drafts: { draft: 2 },
    });
  });

  it("stores and reuses snapshots by commit", async () => {
    const data = { tree: [{ path: "a.ts", size: 1 }], readme: "hi", routing: "Auth -> app/auth/", templates: [], labels: [{ id: 1, name: "bug" }] };
    await repos.saveSnapshot(ids.repo, "sha-live", data);
    await repos.saveSnapshot(ids.repo, "sha-live", { ...data, readme: "ignored on conflict" });
    expect(await repos.getSnapshot(ids.repo, "sha-live")).toEqual(data);
    expect(await repos.getSnapshot(ids.repo, "other-sha")).toBeUndefined();
  });

  it("only requeues failed runs", async () => {
    expect(await runs.requeueRun(ids.run)).toBe(false);
  });
});
