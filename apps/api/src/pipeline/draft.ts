import { randomUUID } from "node:crypto";
import type { SnapshotData } from "../db/repos";
import type { ClaimedRun, DraftToInsert, commitDrafts } from "../db/runs";
import { DRAFT_ISSUES_SYSTEM, DRAFT_ISSUES_VERSION } from "../../prompts/draftIssues.v1";
import { SELECT_FILES_SYSTEM } from "../../prompts/selectFiles.v1";
import { ForgeError, type ForgeClient } from "../forge/types";
import { LlmOutputError, addUsage, describeLlmError, isRetryableLlmError, type LlmClient, type Usage } from "../llm";
import { CHARS_PER_TOKEN, estimateTokens, renderFileList } from "./budget";
import { describeTemplate, findTemplatePaths, parseTemplate, type IssueTemplate } from "./templates";
import { filterTree, findReadme, findRouting } from "./tree";
import { normalizeDropdownAnswers, sanitizeDraft, validateDrafts, type DraftOutput, type ValidationContext } from "./validate";

/** Netlify runs a background function once and retries it twice. */
export const MAX_JOB_ATTEMPTS = 3;
export const MAX_SELECTED_FILES = 20;
export const MAX_LINES_PER_FILE = 400;
export const MAX_CONTEXT_CHARS = 150_000;
export const README_EXCERPT_CHARS = 8_000;
const MAX_README_CHARS = 50_000;
/** A routing map is an index, not documentation; anything longer is cut with a note. */
export const MAX_ROUTING_CHARS = 30_000;
/** File-selection prompt size guard: roughly the Haiku context budget for paths. */
export const MAX_LISTED_FILES = 8_000;
const FETCH_CONCURRENCY = 5;

export interface DraftJobStore {
  claimRun(runId: string): Promise<ClaimedRun | undefined>;
  setRunProgress(runId: string, status: "reading_repo" | "selecting_files" | "drafting", fields?: { commitSha?: string }): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  updateDefaultBranch(repoId: string, branch: string): Promise<void>;
  getSnapshot(repoId: string, sha: string): Promise<SnapshotData | undefined>;
  saveSnapshot(repoId: string, sha: string, data: SnapshotData): Promise<void>;
  commitDrafts: typeof commitDrafts;
}

export interface DraftJobDeps {
  store: DraftJobStore;
  forge: ForgeClient;
  llm: LlmClient;
  models: { select: string; draft: string };
  /**
   * Invocations the platform will make before giving up. Netlify retries a
   * background function twice; `netlify dev` never retries, so pass 1 there.
   */
  maxAttempts?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export type DraftJobResult =
  | { outcome: "skipped" }
  | { outcome: "done"; draftIds: string[]; snapshotReused: boolean }
  | { outcome: "duplicate" }
  | { outcome: "failed"; error: string };

/** A failure the platform retry could fix. Thrown out of the job so Netlify retries it. */
export class TransientJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientJobError";
  }
}

/** A failure that retrying will not fix, with a message meant for the user. */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof ForgeError) return err.retryable;
  if (err instanceof LlmOutputError || err instanceof JobFailure) return false;
  if (isRetryableLlmError(err)) return true;
  // Database or network trouble reaching Neon surfaces as a plain fetch error.
  return err instanceof TypeError && /fetch/i.test(err.message);
}

/** A message for the run's `error` column that a teammate can act on. */
export function describeFailure(err: unknown): string {
  if (err instanceof JobFailure) return err.message;
  const llmMessage = describeLlmError(err);
  if (llmMessage) return llmMessage;
  if (err instanceof ForgeError) {
    if (err.status === 401) return "Gitea rejected the session token. Sign in again and retry.";
    if (err.status === 403 || err.status === 404) return "The repository could not be read with your Gitea account.";
    if (err.status === 413) return `The repository is too large to read (${err.message}).`;
    return `Reading the repository failed: ${err.message}.`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stage 1: read the repo and draft issues for a run (docs/ARCHITECTURE.md
 * section 6). Deterministic failures mark the run failed and return; transient
 * ones are thrown so the platform retries, until the last attempt.
 */
export async function runDraftJob(runId: string, deps: DraftJobDeps): Promise<DraftJobResult> {
  const { store, log = () => {} } = deps;

  const claimed = await store.claimRun(runId);
  if (!claimed) {
    log("run already finished; nothing to do", { runId });
    return { outcome: "skipped" };
  }

  try {
    return await draft(claimed, deps);
  } catch (err) {
    const message = describeFailure(err);
    if (isTransient(err) && claimed.run.attempts < (deps.maxAttempts ?? MAX_JOB_ATTEMPTS)) {
      log("transient failure; leaving the run for a platform retry", { runId, attempt: claimed.run.attempts, message });
      throw new TransientJobError(message, { cause: err });
    }
    log("run failed", { runId, attempt: claimed.run.attempts, message });
    const final = isTransient(err)
      ? `${message} This looks temporary: retry the run in a minute.${claimed.run.attempts > 1 ? ` (Gave up after ${claimed.run.attempts} attempts.)` : ""}`
      : message;
    await store.failRun(runId, final);
    return { outcome: "failed", error: message };
  }
}

async function draft({ run, rawIssue, repo }: ClaimedRun, deps: DraftJobDeps): Promise<DraftJobResult> {
  const { store, forge, llm, models } = deps;
  const repoName = `${repo.owner}/${repo.name}`;

  // 2. Resolve head.
  const info = await forge.getRepo(repo.owner, repo.name);
  if (info.empty) throw new JobFailure("The repository is empty, so there is nothing to read.");
  if (info.defaultBranch !== repo.defaultBranch) {
    await store.updateDefaultBranch(repo.id, info.defaultBranch);
  }
  const sha = await forge.getBranchHead(repo.owner, repo.name, info.defaultBranch);
  await store.setRunProgress(run.id, "reading_repo", { commitSha: sha });

  // 3. Snapshot, cached by commit.
  let snapshot = await store.getSnapshot(repo.id, sha);
  const snapshotReused = snapshot !== undefined;
  if (!snapshot) {
    snapshot = await readSnapshot(forge, repo.owner, repo.name, sha);
    await store.saveSnapshot(repo.id, sha, snapshot);
  }
  if (snapshot.tree.length > MAX_LISTED_FILES) {
    throw new JobFailure(
      `The repository has ${snapshot.tree.length} readable files; file selection supports up to ${MAX_LISTED_FILES}.`,
    );
  }

  // 4. Select files.
  await store.setRunProgress(run.id, "selecting_files");
  const known = new Set(snapshot.tree.map((e) => e.path));
  const { contextTokens } = llm.limits;
  const routing = snapshot.routing ?? "";
  if (!routing) deps.log?.("repository has no ROUTING.md; selecting from the file list alone", { runId: run.id });
  const readmeExcerpt = (snapshot.readme ?? "").slice(
    0,
    contextTokens ? Math.min(README_EXCERPT_CHARS, contextTokens * 0.1 * CHARS_PER_TOKEN) : README_EXCERPT_CHARS,
  );
  const listChars = contextTokens
    ? charsLeft(contextTokens, llm.limits.selectOutputTokens, [SELECT_FILES_SYSTEM, rawIssue.body, readmeExcerpt, routing])
    : Number.POSITIVE_INFINITY;
  if (listChars < 500) {
    throw new JobFailure(tooSmall(contextTokens!, "choose files for these notes"));
  }
  const listing = renderFileList(snapshot.tree, rawIssue.body, listChars, routing);
  if (listing.shown < listing.total) {
    deps.log?.("file list shortened to fit the model context", { runId: run.id, shown: listing.shown, total: listing.total });
  }
  const selection = await llm.selectFiles({
    repo: repoName,
    rawIssue: rawIssue.body,
    readmeExcerpt,
    routing,
    fileList: listing.text,
    shown: listing.shown,
    total: listing.total,
  });
  const paths = [...new Set(selection.paths)].filter((p) => known.has(p)).slice(0, MAX_SELECTED_FILES);
  let usage: Usage = selection.usage;

  // 5. Fetch context, sized to leave room for the drafts and one repair turn.
  const ctx: ValidationContext = { labels: snapshot.labels.map((l) => l.name), templates: snapshot.templates };
  const templates = snapshot.templates.map(describeTemplate).join("\n\n---\n\n");
  let contextChars = MAX_CONTEXT_CHARS;
  if (contextTokens) {
    const room = charsLeft(contextTokens, 2 * llm.limits.draftOutputTokens, [
      DRAFT_ISSUES_SYSTEM,
      rawIssue.body,
      routing,
      templates,
      ctx.labels.join("\n"),
    ]);
    if (room < 0) throw new JobFailure(tooSmall(contextTokens, "draft issues with this template and these notes"));
    contextChars = Math.min(MAX_CONTEXT_CHARS, room);
  }
  const files = await fetchContext(forge, repo.owner, repo.name, sha, paths, contextChars);

  // 6-7. Draft, validate, repair once.
  await store.setRunProgress(run.id, "drafting");
  const conversation = await llm.draftIssues({
    repo: repoName,
    rawIssue: rawIssue.body,
    routing,
    files,
    templates,
    labels: ctx.labels,
  });
  usage = addUsage(usage, conversation.usage);

  let output: DraftOutput = normalizeDropdownAnswers(conversation.output, ctx.templates);
  let errors = validateDrafts(output, ctx);
  if (errors.length > 0) {
    deps.log?.("drafts failed validation; asking for a repair", { runId: run.id, errors });
    const repaired = await conversation.repair(errors);
    usage = addUsage(usage, repaired.usage);
    output = normalizeDropdownAnswers(repaired.output, ctx.templates);
    errors = validateDrafts(output, ctx);
    if (errors.length > 0) {
      throw new LlmOutputError(
        `The AI drafts were still invalid after one repair: ${errors.slice(0, 5).join(" ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}`,
      );
    }
  }

  // 8-9. Sanitize and commit atomically.
  const idByKey = new Map(output.drafts.map((d) => [d.key, randomUUID()]));
  const rows: DraftToInsert[] = output.drafts.map((d) => {
    const clean = sanitizeDraft(d, ctx);
    return {
      id: idByKey.get(d.key)!,
      title: clean.title,
      body: clean.body,
      template_name: clean.template_name,
      labels: clean.labels,
      depends_on_ids: clean.depends_on.map((k) => idByKey.get(k)!),
    };
  });

  const written = await store.commitDrafts({
    runId: run.id,
    repoId: repo.id,
    authorId: rawIssue.authorId,
    drafts: rows,
    reviewerNotes: output.reviewer_notes,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    promptVersion: DRAFT_ISSUES_VERSION,
    modelSelect: models.select,
    modelDraft: models.draft,
  });
  if (!written) {
    deps.log?.("another invocation already finished this run; discarding these drafts", { runId: run.id });
    return { outcome: "duplicate" };
  }
  return { outcome: "done", draftIds: rows.map((r) => r.id), snapshotReused };
}

/** Prompt wrapper, tool schema, and estimation slack, in tokens. */
const PROMPT_OVERHEAD_TOKENS = 1_200;

/** Characters left for variable content once fixed prompt parts and output are reserved. */
function charsLeft(contextTokens: number, outputTokens: number, fixedParts: string[]): number {
  const fixed = fixedParts.reduce((sum, part) => sum + estimateTokens(part), 0);
  return (contextTokens - outputTokens - fixed - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
}

const tooSmall = (contextTokens: number, what: string) =>
  `The model context window (${contextTokens} tokens) is too small to ${what}. Load the model with a larger context length and update LMSTUDIO_CONTEXT_TOKENS, or shorten the notes.`;

export async function readSnapshot(forge: ForgeClient, owner: string, repo: string, sha: string): Promise<SnapshotData> {
  const fullTree = await forge.getTree(owner, repo, sha);

  const routingEntry = findRouting(fullTree);
  let routing: string | null = null;
  if (routingEntry) {
    const text = await forge.getRawFile(owner, repo, routingEntry.path, sha);
    routing = text.length > MAX_ROUTING_CHARS
      ? `${text.slice(0, MAX_ROUTING_CHARS)}
[... truncated: ROUTING.md is longer than ${MAX_ROUTING_CHARS} characters ...]`
      : text;
  }

  const readmeEntry = findReadme(fullTree);
  const readme = readmeEntry
    ? (await forge.getRawFile(owner, repo, readmeEntry.path, sha)).slice(0, MAX_README_CHARS)
    : null;

  const templates: IssueTemplate[] = [];
  for (const path of findTemplatePaths(fullTree)) {
    const parsed = parseTemplate(path, await forge.getRawFile(owner, repo, path, sha));
    if (parsed) templates.push(parsed);
  }

  const labels = await forge.listLabels(owner, repo);
  return { tree: filterTree(fullTree), readme, routing, templates, labels };
}

/** Selected files as prompt text, truncated per file and in total, with truncation noted inline. */
export async function fetchContext(
  forge: ForgeClient,
  owner: string,
  repo: string,
  sha: string,
  paths: string[],
  maxChars = MAX_CONTEXT_CHARS,
): Promise<string> {
  const contents = new Array<string | undefined>(paths.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, paths.length) }, async () => {
      while (next < paths.length) {
        const index = next++;
        try {
          contents[index] = await forge.getRawFile(owner, repo, paths[index]!, sha);
        } catch (err) {
          if (err instanceof ForgeError && !err.retryable) contents[index] = undefined;
          else throw err;
        }
      }
    }),
  );

  const parts: string[] = [];
  let total = 0;
  for (const [i, path] of paths.entries()) {
    const content = contents[i];
    if (content === undefined || content.includes("\u0000")) continue;

    const lines = content.split("\n");
    let text = lines.slice(0, MAX_LINES_PER_FILE).join("\n");
    if (lines.length > MAX_LINES_PER_FILE) {
      text += `\n[... truncated: showing ${MAX_LINES_PER_FILE} of ${lines.length} lines ...]`;
    }
    const remaining = maxChars - total;
    if (remaining <= 0) {
      parts.push(`<file path="${path}">\n[... omitted: context limit reached ...]\n</file>`);
      continue;
    }
    if (text.length > remaining) {
      text = `${text.slice(0, remaining)}\n[... truncated: context limit reached ...]`;
    }
    total += text.length;
    parts.push(`<file path="${path}">\n${text}\n</file>`);
  }
  return parts.join("\n\n");
}
