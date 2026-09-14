import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { TERMINAL_RUN_STATUSES, type RunStatus, type RunSummary } from "@issue-pipeline/shared";
import { getDb, schema } from "./client";
import type { Repo, Run, TemplateSnapshot } from "./schema";

export async function countRunsSince(authorId: string, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(schema.runs)
    .innerJoin(schema.rawIssues, eq(schema.runs.rawIssueId, schema.rawIssues.id))
    .where(and(eq(schema.rawIssues.authorId, authorId), gt(schema.runs.createdAt, since)));
  return row?.n ?? 0;
}

/** Insert a raw issue and its queued run atomically, with the app template (if any) copied onto the run. */
export async function createRawIssueWithRun(input: {
  repoId: string;
  authorId: string;
  body: string;
  template?: TemplateSnapshot;
}): Promise<string> {
  const rawIssueId = randomUUID();
  const runId = randomUUID();
  const { template, ...rawIssue } = input;
  const db = getDb();
  await db.batch([
    db.insert(schema.rawIssues).values({ id: rawIssueId, ...rawIssue, templateId: template?.id ?? null }),
    db.insert(schema.runs).values({ id: runId, rawIssueId, templateSnapshot: template ?? null }),
  ]);
  return runId;
}

export interface RunDetails {
  run: Run;
  repoId: string;
  rawIssue: string;
  draftIds: string[];
}

export async function getRunDetails(runId: string): Promise<RunDetails | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ run: schema.runs, repoId: schema.rawIssues.repoId, rawIssue: schema.rawIssues.body })
    .from(schema.runs)
    .innerJoin(schema.rawIssues, eq(schema.runs.rawIssueId, schema.rawIssues.id))
    .where(eq(schema.runs.id, runId));
  if (!row) return undefined;
  const drafts = await db
    .select({ id: schema.drafts.id })
    .from(schema.drafts)
    .where(eq(schema.drafts.runId, runId))
    .orderBy(schema.drafts.createdAt);
  return { ...row, draftIds: drafts.map((d) => d.id) };
}

/** Everything the drafting job needs about a run it has just claimed. */
export interface ClaimedRun {
  run: Run;
  rawIssue: { body: string; authorId: string };
  repo: Repo;
}

/**
 * Start (or restart, on a platform retry) a run. Returns undefined when the
 * run is already done or failed, so a duplicate invocation exits quietly.
 */
export async function claimRun(runId: string): Promise<ClaimedRun | undefined> {
  const db = getDb();
  const [run] = await db
    .update(schema.runs)
    .set({
      status: "reading_repo",
      attempts: sql`${schema.runs.attempts} + 1`,
      startedAt: sql`now()`,
      finishedAt: null,
      error: null,
    })
    .where(and(eq(schema.runs.id, runId), notInArray(schema.runs.status, [...TERMINAL_RUN_STATUSES])))
    .returning();
  if (!run) return undefined;

  const [row] = await db
    .select({ rawIssue: schema.rawIssues, repo: schema.repos })
    .from(schema.rawIssues)
    .innerJoin(schema.repos, eq(schema.rawIssues.repoId, schema.repos.id))
    .where(eq(schema.rawIssues.id, run.rawIssueId));
  if (!row) throw new Error(`run ${runId} has no raw issue`);
  return { run, rawIssue: { body: row.rawIssue.body, authorId: row.rawIssue.authorId }, repo: row.repo };
}

export async function setRunProgress(
  runId: string,
  status: Extract<RunStatus, "reading_repo" | "selecting_files" | "drafting">,
  fields: { commitSha?: string } = {},
): Promise<void> {
  await getDb()
    .update(schema.runs)
    .set({ status, ...fields })
    .where(and(eq(schema.runs.id, runId), notInArray(schema.runs.status, [...TERMINAL_RUN_STATUSES])));
}

export async function failRun(runId: string, error: string): Promise<void> {
  await getDb()
    .update(schema.runs)
    .set({ status: "failed", error: error.slice(0, 2000), finishedAt: sql`now()` })
    .where(and(eq(schema.runs.id, runId), notInArray(schema.runs.status, ["done"])));
}

/** failed -> queued. Returns false if the run was not failed. */
export async function requeueRun(runId: string): Promise<boolean> {
  const rows = await getDb()
    .update(schema.runs)
    .set({ status: "queued", error: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.status, "failed")))
    .returning({ id: schema.runs.id });
  return rows.length > 0;
}

/**
 * Mark a run failed if its job evidently died: running longer than a
 * background function can, or queued and never picked up.
 */
export async function failIfStale(runId: string, cutoff: Date): Promise<void> {
  await getDb()
    .update(schema.runs)
    .set({ status: "failed", error: "The drafting job stopped responding. Retry the run.", finishedAt: sql`now()` })
    .where(
      and(
        eq(schema.runs.id, runId),
        inArray(schema.runs.status, ["queued", "reading_repo", "selecting_files", "drafting"]),
        sql`coalesce(${schema.runs.startedAt}, ${schema.runs.createdAt}) < ${cutoff.toISOString()}`,
      ),
    );
}

export interface DraftToInsert {
  id: string;
  title: string;
  body: string;
  template_name: string | null;
  labels: string[];
  depends_on_ids: string[];
}

/**
 * Write a run's drafts, dependencies, and `created` events, and mark the run
 * done -- all in one transaction, and only if this invocation is the one that
 * moves the run out of `drafting`. A duplicate or late job invocation writes
 * nothing, so a retried job can never duplicate drafts.
 *
 * Returns whether the drafts were written.
 */
export async function commitDrafts(input: {
  runId: string;
  repoId: string;
  authorId: string;
  drafts: DraftToInsert[];
  reviewerNotes: string | null;
  inputTokens: number;
  outputTokens: number;
  promptVersion: string;
  modelSelect: string;
  modelDraft: string;
}): Promise<boolean> {
  const client = getDb().$client;
  const draftsJson = JSON.stringify(input.drafts);
  const depsJson = JSON.stringify(
    input.drafts.flatMap((d) => d.depends_on_ids.map((dep) => ({ draft_id: d.id, depends_on_id: dep }))),
  );
  const eventDetail = JSON.stringify({ run_id: input.runId, reviewer_notes: input.reviewerNotes });

  const [inserted] = await client.transaction([
    client`
      WITH claimed AS (
        UPDATE runs
        SET status = 'done', finished_at = now(), error = NULL,
            input_tokens = ${input.inputTokens}, output_tokens = ${input.outputTokens},
            prompt_version = ${input.promptVersion},
            model_select = ${input.modelSelect}, model_draft = ${input.modelDraft}
        WHERE id = ${input.runId} AND status = 'drafting'
        RETURNING id
      )
      INSERT INTO drafts (id, run_id, repo_id, title, body, template_name, labels, created_by)
      SELECT (d->>'id')::uuid, claimed.id, ${input.repoId}::uuid, d->>'title', d->>'body',
             d->>'template_name', ARRAY(SELECT jsonb_array_elements_text(d->'labels')),
             ${input.authorId}::uuid
      FROM claimed CROSS JOIN jsonb_array_elements(${draftsJson}::jsonb) AS d
      RETURNING id`,
    client`
      INSERT INTO draft_deps (draft_id, depends_on_id)
      SELECT (e->>'draft_id')::uuid, (e->>'depends_on_id')::uuid
      FROM jsonb_array_elements(${depsJson}::jsonb) AS e
      WHERE EXISTS (SELECT 1 FROM drafts WHERE id = (e->>'draft_id')::uuid)`,
    client`
      INSERT INTO draft_events (draft_id, actor_id, event, detail)
      SELECT (d->>'id')::uuid, ${input.authorId}::uuid, 'created', ${eventDetail}::jsonb
      FROM jsonb_array_elements(${draftsJson}::jsonb) AS d
      WHERE EXISTS (SELECT 1 FROM drafts WHERE id = (d->>'id')::uuid)`,
  ]);

  return Array.isArray(inserted) && inserted.length > 0;
}

const EXCERPT_CHARS = 160;

/** The newest runs across the team, with repo, author, and draft counts by status. */
export async function listRuns(limit: number): Promise<RunSummary[]> {
  const db = getDb();
  const rows = await db
    .select({
      run: schema.runs,
      body: schema.rawIssues.body,
      repo: { id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name },
      author: { username: schema.users.username, displayName: schema.users.displayName },
    })
    .from(schema.runs)
    .innerJoin(schema.rawIssues, eq(schema.runs.rawIssueId, schema.rawIssues.id))
    .innerJoin(schema.repos, eq(schema.rawIssues.repoId, schema.repos.id))
    .innerJoin(schema.users, eq(schema.rawIssues.authorId, schema.users.id))
    .orderBy(desc(schema.runs.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const counts = await db
    .select({ runId: schema.drafts.runId, status: schema.drafts.status, n: count() })
    .from(schema.drafts)
    .where(inArray(schema.drafts.runId, rows.map((r) => r.run.id)))
    .groupBy(schema.drafts.runId, schema.drafts.status);

  return rows.map(({ run, body, repo, author }) => {
    const oneLine = body.replace(/\s+/g, " ").trim();
    return {
      id: run.id,
      status: run.status as RunStatus,
      error: run.error,
      attempts: run.attempts,
      repo,
      author: { username: author.username, display_name: author.displayName },
      excerpt: oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS - 3)}...` : oneLine,
      drafts: Object.fromEntries(
        counts.filter((c) => c.runId === run.id).map((c) => [c.status, c.n]),
      ) as RunSummary["drafts"],
      created_at: run.createdAt.toISOString(),
      started_at: run.startedAt?.toISOString() ?? null,
      finished_at: run.finishedAt?.toISOString() ?? null,
    };
  });
}
