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
    expect(b.depends_on).toEqual([{ id: first[0]!.id, title: "first A", status: "draft", gitea_number: null }]);
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

  describe("review writes", () => {
    const drafts = () => import("./drafts");
    const detail = async (id: string) => (await (await drafts()).getDraftDetail(id))!;

    it("lets the first of two edits from the same version win and refuses the second", async () => {
      const d = await drafts();
      const target = (await d.listDrafts({ runId: ids.run })).find((x) => x.title === "first A")!;
      const start = target.version;

      expect(await d.updateDraftContent({ id: target.id, actorId: ids.user, version: start, title: "Edited A", labels: ["x"] })).toBe(true);
      expect(await d.updateDraftContent({ id: target.id, actorId: ids.user, version: start, title: "Stale edit" })).toBe(false);

      const after = await detail(target.id);
      expect(after).toMatchObject({ title: "Edited A", labels: ["x"], version: start + 1 });
      expect(after.events[0]).toMatchObject({ event: "edited", detail: { fields: ["title", "labels"] } });
    });

    it("makes approved drafts read-only until unapproved", async () => {
      const d = await drafts();
      const target = (await d.listDrafts({ runId: ids.run })).find((x) => x.title === "Edited A")!;
      const v = target.version;

      expect(await d.approveDraft({ id: target.id, actorId: ids.user, version: v - 1 })).toBe(false);
      expect(await d.approveDraft({ id: target.id, actorId: ids.user, version: v })).toBe(true);
      expect(await d.updateDraftContent({ id: target.id, actorId: ids.user, version: v + 1, body: "nope" })).toBe(false);
      expect(await d.deleteDraft(target.id)).toBe(false);
      expect((await detail(target.id)).approved_by).toMatch(/^live-test-/);

      expect(await d.unapproveDraft({ id: target.id, actorId: ids.user })).toBe(true);
      expect(await d.unapproveDraft({ id: target.id, actorId: ids.user })).toBe(false);
      const after = await detail(target.id);
      expect(after).toMatchObject({ status: "draft", approved_by: null, version: v + 2 });
      expect(after.events.slice(0, 2).map((e) => e.event)).toEqual(["unapproved", "approved"]);
    });

    it("replaces dependencies and blocks a cycle in the database even without the app check", async () => {
      const d = await drafts();
      const all = await d.listDrafts({ runId: ids.run });
      const a = all.find((x) => x.title === "Edited A")!;
      const b = all.find((x) => x.title === "first B")!;

      // Fixture: B depends on A. Clear that, then point A at B.
      expect(await d.replaceDependencies({ id: b.id, actorId: ids.user, version: b.version, dependsOnIds: [] })).toBe(true);
      expect((await detail(b.id)).depends_on).toEqual([]);
      const aNow = await detail(a.id);
      expect(await d.replaceDependencies({ id: a.id, actorId: ids.user, version: aNow.version, dependsOnIds: [b.id] })).toBe(true);

      // B -> A would now close a loop, so the database guard must refuse it.
      const bNow = await detail(b.id);
      await expect(
        d.replaceDependencies({ id: b.id, actorId: ids.user, version: bNow.version, dependsOnIds: [a.id] }),
      ).rejects.toBeInstanceOf(d.DependencyCycleError);
      const bAfter = await detail(b.id);
      expect(bAfter.depends_on).toEqual([]);
      expect(bAfter.version).toBe(bNow.version);
      expect(bAfter.dependents.map((x) => x.id)).toEqual([a.id]);
    });

    it("deletes only drafts in draft status", async () => {
      const d = await drafts();
      const target = (await d.listDrafts({ runId: ids.run })).find((x) => x.title === "first B")!;
      expect(await d.deleteDraft(target.id)).toBe(true);
      expect(await d.getDraftDetail(target.id)).toBeUndefined();
    });
  });

  describe("posting", () => {
    const drafts = () => import("./drafts");
    const detail = async (id: string) => (await (await drafts()).getDraftDetail(id))!;
    const p1 = randomUUID();
    const p2 = randomUUID();

    beforeAll(async () => {
      const db = getDb();
      await db.insert(schema.drafts).values([
        { id: p1, repoId: ids.repo, title: "Schema", body: "Body", status: "approved", createdBy: ids.user, approvedBy: ids.user },
        { id: p2, repoId: ids.repo, title: "Endpoint", body: "Body", status: "approved", createdBy: ids.user, approvedBy: ids.user },
      ]);
      await db.insert(schema.draftDeps).values({ draftId: p2, dependsOnId: p1 });
    });

    it("finds the oldest ready draft, skipping one with an unposted dependency", async () => {
      const d = await drafts();
      expect(await d.findReadyDraftId(ids.repo)).toBe(p1);
      expect(await d.claimDraftForPosting(p2, ids.user)).toBe(false);
    });

    it("claims approved -> posting exactly once, then posts it", async () => {
      const d = await drafts();
      expect(await d.claimDraftForPosting(p1, ids.user)).toBe(true);
      expect(await d.claimDraftForPosting(p1, ids.user)).toBe(false);
      expect((await detail(p1)).status).toBe("posting");

      expect(
        await d.markDraftPosted({ id: p1, actorId: ids.user, giteaNumber: 101, giteaUrl: "https://git.example/o/r/issues/101", droppedLabels: ["ghost"] }),
      ).toBe(true);
      const after = await detail(p1);
      expect(after).toMatchObject({ status: "posted", gitea_number: 101, gitea_url: "https://git.example/o/r/issues/101" });
      expect(after.events[0]).toMatchObject({ event: "posted", detail: { gitea_number: 101, dropped_labels: ["ghost"] } });
    });

    it("marks a failed post and lets it be retried back to approved", async () => {
      const d = await drafts();
      expect(await d.findReadyDraftId(ids.repo)).toBe(p2); // p1 is now posted, so p2 is ready
      expect(await d.claimDraftForPosting(p2, ids.user)).toBe(true);

      expect(await d.markDraftFailed({ id: p2, actorId: ids.user, error: "Gitea returned 422" })).toBe(true);
      expect(await detail(p2)).toMatchObject({ status: "failed", last_error: "Gitea returned 422" });

      expect(await d.retryFailedDraft(p2)).toBe(true);
      expect(await d.retryFailedDraft(p2)).toBe(false); // no longer failed
      expect(await detail(p2)).toMatchObject({ status: "approved", last_error: null });
    });

    it("reconciles a stuck posting by searching for it on Gitea", async () => {
      const d = await drafts();
      expect(await d.claimDraftForPosting(p2, ids.user)).toBe(true);

      const stale = new Date(Date.now() - 6 * 60_000);
      await getDb().update(schema.drafts).set({ claimedAt: stale }).where(eq(schema.drafts.id, p2));

      const ctx = await d.getReconcileContext(p2);
      expect(ctx).toMatchObject({ status: "posting", claimedByUsername: expect.stringMatching(/^live-test-/), repoOwner: "live-test" });
      expect(new Date(ctx!.claimedAt!).getTime()).toBe(stale.getTime());

      // Found on Gitea: reconcile marks it posted rather than risking a duplicate.
      expect(await d.reconcileToPosted({ id: p2, actorId: ids.user, giteaNumber: 202, giteaUrl: "https://git.example/o/r/issues/202" })).toBe(true);
      expect(await d.reconcileToPosted({ id: p2, actorId: ids.user, giteaNumber: 202, giteaUrl: "u" })).toBe(false);
      const after = await detail(p2);
      expect(after).toMatchObject({ status: "posted", gitea_number: 202 });
      expect(after.events[0]).toMatchObject({ event: "reconciled", detail: { outcome: "posted", gitea_number: 202 } });
    });

    it("returns a stuck posting to approved when reconcile finds nothing on Gitea", async () => {
      const d = await drafts();
      const p3 = randomUUID();
      await getDb()
        .insert(schema.drafts)
        .values({ id: p3, repoId: ids.repo, title: "Ghost", body: "Body", status: "approved", createdBy: ids.user, approvedBy: ids.user });
      expect(await d.claimDraftForPosting(p3, ids.user)).toBe(true);

      expect(await d.reconcileToApproved({ id: p3, actorId: ids.user })).toBe(true);
      expect(await d.reconcileToApproved({ id: p3, actorId: ids.user })).toBe(false);
      const after = await detail(p3);
      expect(after).toMatchObject({ status: "approved", version: expect.any(Number) });
      expect(after.events[0]).toMatchObject({ event: "reconciled", detail: { outcome: "approved" } });
    });

    it("marks a dependency linked, records a link failure, and logs reconciled link retries", async () => {
      const d = await drafts();
      const ctx = await d.getReconcileContext(p2);
      expect(ctx!.unlinkedDeps).toEqual([{ dependsOnId: p1, giteaNumber: 101 }]);

      await d.markDependencyLinked(p2, p1);
      expect((await d.getReconcileContext(p2))!.unlinkedDeps).toEqual([]);

      await d.recordLinkFailed({ draftId: p2, actorId: ids.user, dependsOnId: p1, error: "dependencies not enabled" });
      await d.recordReconciledLinks({ id: p2, actorId: ids.user, linked: 1, stillFailing: 1 });
      const after = await detail(p2);
      expect(after.events[0]).toMatchObject({ event: "reconciled", detail: { outcome: "links", linked: 1, still_failing: 1 } });
      expect(after.events[1]).toMatchObject({ event: "link_failed", detail: { depends_on_id: p1 } });
    });
  });
});
