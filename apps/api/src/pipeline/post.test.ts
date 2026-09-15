import type { DraftDetail } from "@issue-pipeline/shared";
import { describe, expect, it } from "vitest";
import type { ReconcileContext } from "../db/drafts";
import { fakeForge } from "../forge/fake";
import { ForgeError } from "../forge/types";
import { postDraft, reconcileDraft, type PostStore, type ReconcileStore } from "./post";

const DRAFT_ID = "00000000-0000-4000-8000-0000000000aa";
const ACTOR = "00000000-0000-4000-8000-0000000000bb";

function baseDetail(overrides: Partial<DraftDetail> = {}): DraftDetail {
  return {
    id: DRAFT_ID,
    run_id: null,
    repo_id: "repo-1",
    repo: { forge: "gitea", owner: "TrueRoster", name: "app" },
    title: "Add schema",
    body: "Do the thing.",
    template_name: null,
    labels: ["backend"],
    status: "approved",
    version: 2,
    depends_on: [],
    created_by: "kayela",
    approved_by: "kayela",
    gitea_number: null,
    gitea_url: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dependents: [],
    events: [],
    ...overrides,
  };
}

/** An in-memory PostStore that follows the same claim/mark semantics as the DB. */
function memoryPostStore(detail: DraftDetail) {
  let current = detail;
  const posted: Array<{ giteaNumber: number; giteaUrl: string; droppedLabels: string[] }> = [];
  const failed: string[] = [];
  const linked: string[] = [];
  const linkFailures: string[] = [];

  const store: PostStore = {
    async claimDraftForPosting() {
      const ready = current.status === "approved" && current.depends_on.every((d) => d.status === "posted");
      if (!ready) return false;
      current = { ...current, status: "posting" };
      return true;
    },
    async getDraftDetail() {
      return current;
    },
    async markDraftPosted(input) {
      if (current.status !== "posting") return false;
      current = { ...current, status: "posted", gitea_number: input.giteaNumber, gitea_url: input.giteaUrl };
      posted.push({ giteaNumber: input.giteaNumber, giteaUrl: input.giteaUrl, droppedLabels: input.droppedLabels });
      return true;
    },
    async markDraftFailed(input) {
      if (current.status !== "posting") return false;
      current = { ...current, status: "failed", last_error: input.error };
      failed.push(input.error);
      return true;
    },
    async markDependencyLinked(_draftId, dependsOnId) {
      linked.push(dependsOnId);
    },
    async recordLinkFailed(input) {
      linkFailures.push(input.dependsOnId);
    },
  };
  return { store, posted, failed, linked, linkFailures, current: () => current };
}

describe("postDraft", () => {
  it("refuses to claim a draft that is not approved", async () => {
    const { store } = memoryPostStore(baseDetail({ status: "draft" }));
    const err = await postDraft(DRAFT_ID, ACTOR, fakeForge(), store).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "status" } });
  });

  it("refuses to claim a draft with unposted dependencies", async () => {
    const { store } = memoryPostStore(
      baseDetail({ depends_on: [{ id: "d1", title: "Schema", status: "draft", gitea_number: null }] }),
    );
    const err = await postDraft(DRAFT_ID, ACTOR, fakeForge(), store).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "unposted_deps" } });
  });

  it("posts, maps label names to ids, drops unknown labels, and links posted dependencies", async () => {
    const { store, posted, linked } = memoryPostStore(
      baseDetail({
        labels: ["backend", "ghost-label"],
        depends_on: [{ id: "d1", title: "Schema", status: "posted", gitea_number: 12 }],
      }),
    );
    const forge = fakeForge({
      listLabels: async () => [{ id: 1, name: "backend" }],
      createIssue: async (_o, _r, input) => {
        expect(input.labels.map((l) => l.id)).toEqual([1]);
        expect(input.body).toContain("**Depends on:** #12");
        expect(input.body).toContain(`<!-- issue-pipeline:draft:${DRAFT_ID} -->`);
        return { number: 42, url: "https://git.example.com/o/r/issues/42" };
      },
      addDependency: async (_o, _r, issue, dependsOn) => {
        expect(issue).toBe(42);
        expect(dependsOn).toBe(12);
      },
    });

    const result = await postDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result).toEqual({ status: "posted", gitea_number: 42, gitea_url: "https://git.example.com/o/r/issues/42" });
    expect(posted).toEqual([{ giteaNumber: 42, giteaUrl: "https://git.example.com/o/r/issues/42", droppedLabels: ["ghost-label"] }]);
    expect(linked).toEqual(["d1"]);
  });

  it("marks the draft failed when the label lookup fails deterministically", async () => {
    const { store, failed } = memoryPostStore(baseDetail());
    const forge = fakeForge({ listLabels: async () => { throw new ForgeError("nope", 404, false); } });
    const result = await postDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result.status).toBe("failed");
    expect(failed).toHaveLength(1);
  });

  it("leaves the draft posting on an ambiguous createIssue failure instead of guessing", async () => {
    const { store, failed, current } = memoryPostStore(baseDetail());
    const forge = fakeForge({
      listLabels: async () => [{ id: 1, name: "backend" }],
      createIssue: async () => {
        throw new ForgeError("Gitea returned 502", 502, true);
      },
    });
    const result = await postDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result).toEqual({ status: "posting" });
    expect(failed).toHaveLength(0);
    expect(current().status).toBe("posting");
  });

  it("marks the draft failed on a definite (non-retryable) createIssue failure", async () => {
    const { store, failed } = memoryPostStore(baseDetail());
    const forge = fakeForge({
      listLabels: async () => [{ id: 1, name: "backend" }],
      createIssue: async () => {
        throw new ForgeError("Gitea returned 422", 422, false);
      },
    });
    const result = await postDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result.status).toBe("failed");
    expect(failed).toHaveLength(1);
  });

  it("records a link failure without undoing the post", async () => {
    const { store, posted, linkFailures } = memoryPostStore(
      baseDetail({ depends_on: [{ id: "d1", title: "Schema", status: "posted", gitea_number: 12 }] }),
    );
    const forge = fakeForge({
      listLabels: async () => [{ id: 1, name: "backend" }],
      createIssue: async () => ({ number: 42, url: "u" }),
      addDependency: async () => {
        throw new ForgeError("dependencies not enabled", 404, false);
      },
    });
    const result = await postDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result.status).toBe("posted");
    expect(posted).toHaveLength(1);
    expect(linkFailures).toEqual(["d1"]);
  });
});

function memoryReconcileStore(ctx: ReconcileContext) {
  let current = ctx;
  const linked: string[] = [];
  const linkFailures: string[] = [];
  let reconciledOutcome: unknown;

  const store: ReconcileStore = {
    async getReconcileContext() {
      return current;
    },
    async reconcileToPosted(input) {
      if (current.status !== "posting") return false;
      current = { ...current, status: "posted", giteaNumber: input.giteaNumber };
      reconciledOutcome = { outcome: "posted", gitea_number: input.giteaNumber };
      return true;
    },
    async reconcileToApproved() {
      if (current.status !== "posting") return false;
      current = { ...current, status: "approved" };
      reconciledOutcome = { outcome: "approved" };
      return true;
    },
    async markDependencyLinked(_draftId, dependsOnId) {
      linked.push(dependsOnId);
    },
    async recordLinkFailed(input) {
      linkFailures.push(input.dependsOnId);
    },
    async recordReconciledLinks(input) {
      reconciledOutcome = { outcome: "links", linked: input.linked, still_failing: input.stillFailing };
    },
  };
  return { store, linked, linkFailures, current: () => current, reconciledOutcome: () => reconciledOutcome };
}

const baseContext = (overrides: Partial<ReconcileContext> = {}): ReconcileContext => ({
  status: "posting",
  claimedByUsername: "kayela",
  claimedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  giteaNumber: null,
  repoOwner: "TrueRoster",
  repoName: "app",
  unlinkedDeps: [],
  ...overrides,
});

describe("reconcileDraft", () => {
  it("refuses to reconcile a posting that is not yet stale", async () => {
    const { store } = memoryReconcileStore(baseContext({ claimedAt: new Date().toISOString() }));
    const err = await reconcileDraft(DRAFT_ID, ACTOR, fakeForge(), store).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "not_stale" } });
  });

  it("finds the issue on Gitea and marks the draft posted", async () => {
    const { store, current } = memoryReconcileStore(baseContext());
    const forge = fakeForge({
      listIssuesCreatedBySince: async () => [
        { number: 7, body: `stuff\n<!-- issue-pipeline:draft:${DRAFT_ID} -->`, url: "u7" },
      ],
    });
    const result = await reconcileDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result).toEqual({ outcome: "posted", gitea_number: 7 });
    expect(current().status).toBe("posted");
  });

  it("returns a stuck posting to approved when Gitea never created the issue", async () => {
    const { store, current } = memoryReconcileStore(baseContext());
    const forge = fakeForge({ listIssuesCreatedBySince: async () => [] });
    const result = await reconcileDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result).toEqual({ outcome: "approved" });
    expect(current().status).toBe("approved");
  });

  it("retries unlinked dependency links on a posted draft", async () => {
    const { store, linked, linkFailures } = memoryReconcileStore(
      baseContext({
        status: "posted",
        giteaNumber: 42,
        unlinkedDeps: [
          { dependsOnId: "d1", giteaNumber: 10 },
          { dependsOnId: "d2", giteaNumber: 11 },
        ],
      }),
    );
    const forge = fakeForge({
      addDependency: async (_o, _r, _issue, dependsOn) => {
        if (dependsOn === 11) throw new ForgeError("still not enabled", 404, false);
      },
    });
    const result = await reconcileDraft(DRAFT_ID, ACTOR, forge, store);
    expect(result).toEqual({ outcome: "links", linked: 1, still_failing: 1 });
    expect(linked).toEqual(["d1"]);
    expect(linkFailures).toEqual(["d2"]);
  });

  it("refuses when there is nothing to reconcile", async () => {
    const { store } = memoryReconcileStore(baseContext({ status: "posted", giteaNumber: 42, unlinkedDeps: [] }));
    const err = await reconcileDraft(DRAFT_ID, ACTOR, fakeForge(), store).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", details: { reason: "not_stale" } });
  });
});
