import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotData } from "../db/repos";
import type { ClaimedRun, commitDrafts } from "../db/runs";
import type { Repo, Run } from "../db/schema";
import { fakeForge } from "../forge/fake";
import { ForgeError } from "../forge/types";
import type { DraftConversation, LlmClient } from "../llm";
import { MAX_JOB_ATTEMPTS, TransientJobError, fetchContext, runDraftJob, type DraftJobStore } from "./draft";
import type { DraftOutput } from "./validate";

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";

const repo: Repo = {
  id: "00000000-0000-4000-8000-0000000000bb",
  owner: "TrueRoster",
  name: "app",
  defaultBranch: "main",
  addedBy: null,
  createdAt: new Date(),
};

const goodOutput: DraftOutput = {
  drafts: [
    { key: "a", title: "Add schema", body: "Body A", template_name: null, labels: ["backend"], depends_on: [] },
    { key: "b", title: "Add endpoint", body: "Body B", template_name: null, labels: [], depends_on: ["a"] },
  ],
  reviewer_notes: "Check the migration name.",
};

/** An in-memory stand-in for the runs/snapshots tables with the same claim semantics. */
function memoryStore(opts: { templateSnapshot?: Run["templateSnapshot"] } = {}) {
  const run: Run = {
    id: RUN_ID, rawIssueId: "r", status: "queued", commitSha: null, promptVersion: null, modelSelect: null,
    modelDraft: null, inputTokens: null, outputTokens: null, error: null, attempts: 0,
    templateSnapshot: opts.templateSnapshot ?? null, createdAt: new Date(), startedAt: null, finishedAt: null,
  };
  const snapshots = new Map<string, SnapshotData>();
  const committed: Array<Parameters<typeof commitDrafts>[0]> = [];

  const store: DraftJobStore = {
    async claimRun(): Promise<ClaimedRun | undefined> {
      if (run.status === "done" || run.status === "failed") return undefined;
      run.status = "reading_repo";
      run.attempts += 1;
      return { run: { ...run }, rawIssue: { body: "Add a thing", authorId: "user-1" }, repo };
    },
    async setRunProgress(_id, status, fields) {
      if (run.status !== "done" && run.status !== "failed") Object.assign(run, { status }, fields);
    },
    async failRun(_id, error) {
      if (run.status !== "done") Object.assign(run, { status: "failed", error });
    },
    async updateDefaultBranch() {},
    async getSnapshot(repoId, sha) {
      return snapshots.get(`${repoId}@${sha}`);
    },
    async saveSnapshot(repoId, sha, data) {
      if (!snapshots.has(`${repoId}@${sha}`)) snapshots.set(`${repoId}@${sha}`, data);
    },
    async commitDrafts(input) {
      if (run.status !== "drafting") return false;
      run.status = "done";
      committed.push(input);
      return true;
    },
  };
  return { store, run, committed, snapshots };
}

function forge(overrides: Parameters<typeof fakeForge>[0] = {}) {
  return fakeForge({
    getRepo: async () => ({ defaultBranch: "main", hasIssues: true, empty: false }),
    getBranchHead: async () => "sha-1",
    getTree: vi.fn(async () => [
      { path: "README.md", size: 20 },
      { path: "src/db.ts", size: 50 },
    ]),
    getRawFile: async (_o, _r, path) => `contents of ${path}`,
    listLabels: async () => [{ id: 1, name: "backend" }],
    ...overrides,
  });
}

function llm(
  outputs: DraftOutput[],
  opts: {
    selectError?: unknown;
    contextTokens?: number;
    onSelect?: (input: Parameters<LlmClient["selectFiles"]>[0]) => void;
    onDraft?: (input: Parameters<LlmClient["draftIssues"]>[0]) => void;
  } = {},
): LlmClient & { drafts: number } {
  const client = {
    drafts: 0,
    limits: { contextTokens: opts.contextTokens, selectOutputTokens: 2000, draftOutputTokens: 2000 },
    async selectFiles(input: Parameters<LlmClient["selectFiles"]>[0]) {
      opts.onSelect?.(input);
      if (opts.selectError) throw opts.selectError;
      return { paths: ["src/db.ts", "not/in/tree.ts"], usage: { inputTokens: 10, outputTokens: 5 } };
    },
    async draftIssues(input: Parameters<LlmClient["draftIssues"]>[0]): Promise<DraftConversation> {
      opts.onDraft?.(input);
      client.drafts += 1;
      return {
        output: outputs[0]!,
        usage: { inputTokens: 100, outputTokens: 50 },
        repair: async () => ({ output: outputs[1] ?? outputs[0]!, usage: { inputTokens: 20, outputTokens: 10 } }),
      };
    },
  };
  return client;
}

const models = { select: "claude-haiku-4-5-20251001", draft: "claude-sonnet-5" };

describe("runDraftJob", () => {
  it("drafts, maps keys to ids, and commits with token totals", async () => {
    const { store, run, committed } = memoryStore();
    const result = await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([goodOutput]), models });

    expect(result).toMatchObject({ outcome: "done", snapshotReused: false });
    expect(run.status).toBe("done");
    const [commit] = committed;
    expect(commit).toMatchObject({ runId: RUN_ID, authorId: "user-1", inputTokens: 110, outputTokens: 55, promptVersion: "draftIssues.v1" });
    const [a, b] = commit!.drafts;
    expect(b!.depends_on_ids).toEqual([a!.id]);
    expect(commit!.reviewerNotes).toBe("Check the migration name.");
  });

  it("reuses the snapshot for a second run on the same commit", async () => {
    const shared = memoryStore();
    const f = forge();
    await runDraftJob(RUN_ID, { store: shared.store, forge: f, llm: llm([goodOutput]), models });

    Object.assign(shared.run, { status: "queued" });
    const second = await runDraftJob(RUN_ID, { store: shared.store, forge: f, llm: llm([goodOutput]), models });
    expect(second).toMatchObject({ outcome: "done", snapshotReused: true });
    expect(f.getTree).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid output once, then fails the run with a readable error", async () => {
    const invalid: DraftOutput = { ...goodOutput, drafts: [{ ...goodOutput.drafts[0]!, labels: ["nope"] }] };
    const { store, run } = memoryStore();
    const result = await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([invalid, invalid]), models });

    expect(result).toMatchObject({ outcome: "failed" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/still invalid after one repair: .*label "nope" does not exist/);
  });

  it("accepts output fixed by the repair call", async () => {
    const invalid: DraftOutput = { ...goodOutput, drafts: [{ ...goodOutput.drafts[0]!, labels: ["nope"] }] };
    const { store, run } = memoryStore();
    await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([invalid, goodOutput]), models });
    expect(run.status).toBe("done");
  });

  it("marks deterministic API failures failed without throwing", async () => {
    const { store, run } = memoryStore();
    const badRequest = new Anthropic.BadRequestError(400, { type: "error" }, "bad", new Headers());
    const result = await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([goodOutput], { selectError: badRequest }), models });
    expect(result.outcome).toBe("failed");
    expect(run.error).toMatch(/^The AI request failed \(HTTP 400\)/);
  });

  it("throws transient failures for a platform retry, and a retry produces drafts exactly once", async () => {
    const { store, run, committed } = memoryStore();
    const flakyHead = vi
      .fn()
      .mockRejectedValueOnce(new ForgeError("Gitea returned 503", 503, true))
      .mockResolvedValue("sha-1");
    const f = forge({ getBranchHead: flakyHead });

    await expect(runDraftJob(RUN_ID, { store, forge: f, llm: llm([goodOutput]), models })).rejects.toBeInstanceOf(TransientJobError);
    expect(run.status).toBe("reading_repo");
    expect(committed).toHaveLength(0);

    // The platform retry:
    await runDraftJob(RUN_ID, { store, forge: f, llm: llm([goodOutput]), models });
    expect(run.status).toBe("done");
    expect(run.attempts).toBe(2);
    expect(committed).toHaveLength(1);

    // A late duplicate invocation after completion does nothing.
    expect(await runDraftJob(RUN_ID, { store, forge: f, llm: llm([goodOutput]), models })).toEqual({ outcome: "skipped" });
    expect(committed).toHaveLength(1);
  });

  it("stops retrying on the last attempt and records why", async () => {
    const { store, run } = memoryStore();
    run.attempts = MAX_JOB_ATTEMPTS - 1;
    const f = forge({ getBranchHead: async () => { throw new ForgeError("Gitea returned 503", 503, true); } });
    const result = await runDraftJob(RUN_ID, { store, forge: f, llm: llm([goodOutput]), models });
    expect(result.outcome).toBe("failed");
    expect(run.error).toMatch(/retry the run in a minute\. \(Gave up after 3 attempts\.\)$/);
  });

  it("discards drafts when another invocation already committed", async () => {
    const { store } = memoryStore();
    store.commitDrafts = async () => false;
    expect(await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([goodOutput]), models })).toEqual({ outcome: "duplicate" });
  });
});

describe("fetchContext", () => {
  it("truncates long files and the total, noting it inline, and skips binaries", async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const files: Record<string, string> = { "a.ts": long, "bin.dat": "abc\u0000def", "b.ts": "short" };
    const text = await fetchContext(fakeForge({ getRawFile: async (_o, _r, p) => files[p]! }), "o", "r", "sha", ["a.ts", "bin.dat", "b.ts"]);
    expect(text).toContain("[... truncated: showing 400 of 500 lines ...]");
    expect(text).not.toContain("bin.dat");
    expect(text).toContain('<file path="b.ts">\nshort\n</file>');
  });

  it("skips files that disappeared but surfaces transient errors", async () => {
    const gone = fakeForge({ getRawFile: async () => { throw new ForgeError("404", 404, false); } });
    expect(await fetchContext(gone, "o", "r", "sha", ["x.ts"])).toBe("");
    const flaky = fakeForge({ getRawFile: async () => { throw new ForgeError("503", 503, true); } });
    await expect(fetchContext(flaky, "o", "r", "sha", ["x.ts"])).rejects.toBeInstanceOf(ForgeError);
  });
});

describe("runDraftJob with a small context window", () => {
  const bigTree = Array.from({ length: 1000 }, (_, i) => ({ path: `src/components/widgets/Widget${i}.tsx`, size: 1000 }));

  it("shortens the file list to fit and tells the model it is partial", async () => {
    const { store, run } = memoryStore();
    let seen: Parameters<LlmClient["selectFiles"]>[0] | undefined;
    const f = forge({ getTree: async () => [...bigTree, { path: "src/auth/PasswordReset.tsx", size: 900 }] });
    await runDraftJob(RUN_ID, {
      store,
      forge: f,
      llm: llm([goodOutput], { contextTokens: 8192, onSelect: (input) => (seen = input) }),
      models,
    });

    expect(run.status).toBe("done");
    expect(seen!.shown).toBeLessThan(seen!.total);
    expect(seen!.fileList.length).toBeLessThan(8192 * 3);
    expect(seen!.fileList).toContain("src/auth/PasswordReset.tsx");
  });

  it("fails with guidance when even the fixed prompt does not fit", async () => {
    const { store, run } = memoryStore();
    const result = await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([goodOutput], { contextTokens: 2000 }), models });
    expect(result.outcome).toBe("failed");
    expect(run.error).toMatch(/context window \(2000 tokens\) is too small/);
  });
});

describe("ROUTING.md", () => {
  it("reads ROUTING.md into the snapshot and gives it to both calls", async () => {
    const { store, snapshots } = memoryStore();
    let selectRouting = "";
    let draftRouting = "";
    const f = forge({
      getTree: async () => [
        { path: "README.md", size: 20 },
        { path: "ROUTING.md", size: 40 },
        { path: "src/db.ts", size: 50 },
      ],
      getRawFile: async (_o, _r, path) => (path === "ROUTING.md" ? "Database: src/db.ts" : `contents of ${path}`),
    });
    const client = llm([goodOutput], { onSelect: (input) => (selectRouting = input.routing) });
    const draftIssues = client.draftIssues.bind(client);
    client.draftIssues = async (input) => {
      draftRouting = input.routing;
      return draftIssues(input);
    };

    await runDraftJob(RUN_ID, { store, forge: f, llm: client, models });
    expect([...snapshots.values()][0]!.routing).toBe("Database: src/db.ts");
    expect(selectRouting).toBe("Database: src/db.ts");
    expect(draftRouting).toBe("Database: src/db.ts");
  });

  it("works without one", async () => {
    const { store, run, snapshots } = memoryStore();
    await runDraftJob(RUN_ID, { store, forge: forge(), llm: llm([goodOutput]), models });
    expect(run.status).toBe("done");
    expect([...snapshots.values()][0]!.routing).toBeNull();
  });
});

describe("app templates", () => {
  const repoWithTemplate = () =>
    forge({
      getTree: async () => [
        { path: "README.md", size: 20 },
        { path: ".gitea/ISSUE_TEMPLATE/repo-task.md", size: 30 },
        { path: "src/db.ts", size: 50 },
      ],
      getRawFile: async (_o, _r, path) => (path.endsWith("repo-task.md") ? "## Repo section\n" : `contents of ${path}`),
    });
  const snapshot = {
    id: "00000000-0000-4000-8000-0000000000cc",
    name: "Bug report",
    file: "bug-report.md",
    kind: "markdown" as const,
    content: "---\nlabels: [backend]\n---\n## Steps to reproduce\n",
    version: 3,
  };
  const withTemplate = (template_name: string): DraftOutput => ({
    drafts: [{ key: "a", title: "Crash", body: "## Steps to reproduce\n1. Open", template_name, labels: [], depends_on: [] }],
    reviewer_notes: null,
  });

  it("drafts with the run's app template instead of the repository's, adding its labels", async () => {
    const { store, run, committed } = memoryStore({ templateSnapshot: snapshot });
    let templates = "";
    const client = llm([withTemplate("bug-report.md")], { onDraft: (input) => (templates = input.templates) });

    await runDraftJob(RUN_ID, { store, forge: repoWithTemplate(), llm: client, models });

    expect(run.status).toBe("done");
    expect(templates).toContain("Template file: bug-report.md");
    expect(templates).not.toContain("repo-task.md");
    expect(committed[0]!.drafts[0]).toMatchObject({ template_name: "bug-report.md", labels: ["backend"] });
  });

  it("rejects drafts that pick the repository's template while an app template is in use", async () => {
    const { store, run } = memoryStore({ templateSnapshot: snapshot });
    await runDraftJob(RUN_ID, { store, forge: repoWithTemplate(), llm: llm([withTemplate("repo-task.md")]), models });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/"repo-task.md" is not one of the provided template files/);
  });

  it("fails with guidance when the snapshot cannot be parsed", async () => {
    const { store, run } = memoryStore({ templateSnapshot: { ...snapshot, kind: "form", file: "bad.yml", content: "body: [" } });
    await runDraftJob(RUN_ID, { store, forge: repoWithTemplate(), llm: llm([goodOutput]), models });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/app template "Bug report" could not be read/);
  });
});

describe("runDraftJob without platform retries (netlify dev)", () => {
  it("fails a transient error immediately instead of leaving the run in progress", async () => {
    const { store, run } = memoryStore();
    const f = forge({ getBranchHead: async () => { throw new ForgeError("Gitea returned 503", 503, true); } });
    const result = await runDraftJob(RUN_ID, { store, forge: f, llm: llm([goodOutput]), models, maxAttempts: 1 });
    expect(result.outcome).toBe("failed");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/This looks temporary: retry the run in a minute\.$/);
  });
});
