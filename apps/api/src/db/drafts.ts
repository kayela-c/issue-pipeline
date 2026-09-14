import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  Draft as DraftDto,
  DraftDetail,
  DraftEvent,
  DraftRef,
  DraftStatus,
} from "@issue-pipeline/shared";
import { getDb, schema } from "./client";

const LIST_LIMIT = 500;

const createdBy = alias(schema.users, "created_by_user");
const approvedBy = alias(schema.users, "approved_by_user");

function draftQuery() {
  return getDb()
    .select({
      draft: schema.drafts,
      repo: { owner: schema.repos.owner, name: schema.repos.name },
      createdBy: createdBy.username,
      approvedBy: approvedBy.username,
    })
    .from(schema.drafts)
    .innerJoin(schema.repos, eq(schema.drafts.repoId, schema.repos.id))
    .innerJoin(createdBy, eq(schema.drafts.createdBy, createdBy.id))
    .leftJoin(approvedBy, eq(schema.drafts.approvedBy, approvedBy.id));
}

type DraftRow = Awaited<ReturnType<typeof draftQuery>>[number];

/** Dependency refs for a set of drafts, keyed by the draft that depends. */
async function dependenciesOf(draftIds: string[]): Promise<Map<string, DraftRef[]>> {
  const byDraft = new Map<string, DraftRef[]>();
  if (draftIds.length === 0) return byDraft;
  const target = alias(schema.drafts, "target");
  const rows = await getDb()
    .select({
      draftId: schema.draftDeps.draftId,
      id: target.id,
      title: target.title,
      status: target.status,
      giteaNumber: target.giteaNumber,
    })
    .from(schema.draftDeps)
    .innerJoin(target, eq(schema.draftDeps.dependsOnId, target.id))
    .where(inArray(schema.draftDeps.draftId, draftIds))
    .orderBy(asc(target.createdAt));
  for (const r of rows) {
    const list = byDraft.get(r.draftId) ?? [];
    list.push({ id: r.id, title: r.title, status: r.status as DraftStatus, gitea_number: r.giteaNumber });
    byDraft.set(r.draftId, list);
  }
  return byDraft;
}

function toDto(row: DraftRow, deps: DraftRef[]): DraftDto {
  const d = row.draft;
  return {
    id: d.id,
    run_id: d.runId,
    repo_id: d.repoId,
    repo: row.repo,
    title: d.title,
    body: d.body,
    template_name: d.templateName,
    labels: d.labels,
    status: d.status as DraftStatus,
    version: d.version,
    depends_on: deps,
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    gitea_number: d.giteaNumber,
    gitea_url: d.giteaUrl,
    last_error: d.lastError,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

/** Drafts filtered by repo, run, and/or status, each with its dependencies. */
export async function listDrafts(filter: { repoId?: string; runId?: string; status?: DraftStatus }): Promise<DraftDto[]> {
  const conditions: SQL[] = [];
  if (filter.repoId) conditions.push(eq(schema.drafts.repoId, filter.repoId));
  if (filter.runId) conditions.push(eq(schema.drafts.runId, filter.runId));
  if (filter.status) conditions.push(eq(schema.drafts.status, filter.status));

  const rows = await draftQuery()
    .where(and(...conditions))
    .orderBy(desc(schema.drafts.createdAt), asc(schema.drafts.title))
    .limit(LIST_LIMIT);
  const deps = await dependenciesOf(rows.map((r) => r.draft.id));
  return rows.map((r) => toDto(r, deps.get(r.draft.id) ?? []));
}

export async function getDraftDetail(id: string): Promise<DraftDetail | undefined> {
  const db = getDb();
  const [row] = await draftQuery().where(eq(schema.drafts.id, id));
  if (!row) return undefined;

  const deps = await dependenciesOf([id]);
  const dependents = await db
    .select({
      id: schema.drafts.id,
      title: schema.drafts.title,
      status: schema.drafts.status,
      giteaNumber: schema.drafts.giteaNumber,
    })
    .from(schema.draftDeps)
    .innerJoin(schema.drafts, eq(schema.draftDeps.draftId, schema.drafts.id))
    .where(eq(schema.draftDeps.dependsOnId, id))
    .orderBy(asc(schema.drafts.createdAt));
  const events = await db
    .select({ event: schema.draftEvents, actor: schema.users.username })
    .from(schema.draftEvents)
    .leftJoin(schema.users, eq(schema.draftEvents.actorId, schema.users.id))
    .where(eq(schema.draftEvents.draftId, id))
    .orderBy(desc(schema.draftEvents.createdAt), desc(schema.draftEvents.id));

  return {
    ...toDto(row, deps.get(id) ?? []),
    dependents: dependents.map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status as DraftStatus,
      gitea_number: d.giteaNumber,
    })),
    events: events.map(({ event, actor }) => ({
      id: event.id,
      event: event.event as DraftEvent,
      actor,
      detail: event.detail,
      created_at: event.createdAt.toISOString(),
    })),
  };
}

/** Minimal state of a draft, for validating and explaining a refused change. */
export async function getDraftState(id: string): Promise<{ repoId: string; status: DraftStatus; version: number } | undefined> {
  const [row] = await getDb()
    .select({ repoId: schema.drafts.repoId, status: schema.drafts.status, version: schema.drafts.version })
    .from(schema.drafts)
    .where(eq(schema.drafts.id, id));
  return row ? { ...row, status: row.status as DraftStatus } : undefined;
}

/** Repo and status of the given drafts, for dependency validation. */
export async function getDraftRepos(ids: string[]): Promise<Array<{ id: string; repoId: string }>> {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: schema.drafts.id, repoId: schema.drafts.repoId })
    .from(schema.drafts)
    .where(inArray(schema.drafts.id, ids));
}

/** Every dependency edge between drafts of a repo, as [draft, depends on]. */
export async function repoDependencyEdges(repoId: string): Promise<Array<[string, string]>> {
  const rows = await getDb()
    .select({ from: schema.draftDeps.draftId, to: schema.draftDeps.dependsOnId })
    .from(schema.draftDeps)
    .innerJoin(schema.drafts, eq(schema.draftDeps.draftId, schema.drafts.id))
    .where(eq(schema.drafts.repoId, repoId));
  return rows.map((r) => [r.from, r.to]);
}

// --- Guarded writes ------------------------------------------------------------
//
// Each change is a single statement (or transaction) whose UPDATE is guarded by
// the expected status and, where given, the client's version. The event row is
// written only through that UPDATE's RETURNING, so a refused change writes
// nothing at all. Zero rows back means refused; the caller re-reads the draft
// to say why (not found, wrong status, or stale version).

/** Title/body/labels, only while status = 'draft' and the version matches. */
export async function updateDraftContent(input: {
  id: string;
  actorId: string;
  version: number;
  title?: string;
  body?: string;
  labels?: string[];
}): Promise<boolean> {
  const client = getDb().$client;
  const fields = (["title", "body", "labels"] as const).filter((f) => input[f] !== undefined);
  const labelsJson = input.labels === undefined ? null : JSON.stringify(input.labels);
  const rows = await client`
    WITH updated AS (
      UPDATE drafts
      SET title = coalesce(${input.title ?? null}::text, title),
          body = coalesce(${input.body ?? null}::text, body),
          labels = CASE WHEN ${labelsJson}::jsonb IS NULL THEN labels
                        ELSE ARRAY(SELECT jsonb_array_elements_text(${labelsJson}::jsonb)) END,
          version = version + 1,
          updated_at = now()
      WHERE id = ${input.id} AND status = 'draft' AND version = ${input.version}
      RETURNING id
    ), logged AS (
      INSERT INTO draft_events (draft_id, actor_id, event, detail)
      SELECT id, ${input.actorId}::uuid, 'edited', ${JSON.stringify({ fields })}::jsonb FROM updated
    )
    SELECT id FROM updated`;
  return rows.length > 0;
}

/** Thrown when a dependency change would create a cycle (caught by the database guard). */
export class DependencyCycleError extends Error {
  constructor() {
    super("dependency cycle");
    this.name = "DependencyCycleError";
  }
}

/**
 * Replace a draft's dependencies, only while it is a draft at the expected
 * version. Targets outside the draft's repo are ignored. The transaction ends
 * with a recursive cycle check that aborts it (division by zero) if two
 * concurrent changes would together form a cycle the caller's check missed.
 */
export async function replaceDependencies(input: {
  id: string;
  actorId: string;
  version: number;
  dependsOnIds: string[];
}): Promise<boolean> {
  const client = getDb().$client;
  const ids = [...new Set(input.dependsOnIds)].filter((d) => d !== input.id);
  const idsJson = JSON.stringify(ids);
  try {
    const [changed] = await client.transaction([
      client`
        WITH updated AS (
          UPDATE drafts SET version = version + 1, updated_at = now()
          WHERE id = ${input.id} AND status = 'draft' AND version = ${input.version}
          RETURNING id, repo_id
        ), wanted AS (
          SELECT (value #>> '{}')::uuid AS id FROM jsonb_array_elements(${idsJson}::jsonb)
        ), removed AS (
          DELETE FROM draft_deps
          WHERE draft_id IN (SELECT id FROM updated)
            AND depends_on_id NOT IN (SELECT id FROM wanted)
        ), added AS (
          INSERT INTO draft_deps (draft_id, depends_on_id)
          SELECT u.id, t.id FROM updated u
          JOIN drafts t ON t.repo_id = u.repo_id AND t.id IN (SELECT id FROM wanted)
          ON CONFLICT DO NOTHING
        ), logged AS (
          INSERT INTO draft_events (draft_id, actor_id, event, detail)
          SELECT id, ${input.actorId}::uuid, 'deps_changed', ${JSON.stringify({ depends_on_ids: ids })}::jsonb FROM updated
        )
        SELECT id FROM updated`,
      client`
        WITH RECURSIVE reach(id) AS (
          SELECT depends_on_id FROM draft_deps WHERE draft_id = ${input.id}
          UNION
          SELECT dd.depends_on_id FROM draft_deps dd JOIN reach r ON dd.draft_id = r.id
        )
        SELECT 1 / (NOT EXISTS (SELECT 1 FROM reach WHERE id = ${input.id}))::int AS no_cycle`,
    ]);
    return Array.isArray(changed) && changed.length > 0;
  } catch (err) {
    if ((err as { code?: string }).code === "22012") throw new DependencyCycleError();
    throw err;
  }
}

/** draft -> approved, only at the version the approver reviewed. */
export async function approveDraft(input: { id: string; actorId: string; version: number }): Promise<boolean> {
  const client = getDb().$client;
  const rows = await client`
    WITH updated AS (
      UPDATE drafts
      SET status = 'approved', approved_by = ${input.actorId}::uuid, version = version + 1, updated_at = now()
      WHERE id = ${input.id} AND status = 'draft' AND version = ${input.version}
      RETURNING id
    ), logged AS (
      INSERT INTO draft_events (draft_id, actor_id, event) SELECT id, ${input.actorId}::uuid, 'approved' FROM updated
    )
    SELECT id FROM updated`;
  return rows.length > 0;
}

/** approved -> draft. */
export async function unapproveDraft(input: { id: string; actorId: string }): Promise<boolean> {
  const client = getDb().$client;
  const rows = await client`
    WITH updated AS (
      UPDATE drafts
      SET status = 'draft', approved_by = NULL, version = version + 1, updated_at = now()
      WHERE id = ${input.id} AND status = 'approved'
      RETURNING id
    ), logged AS (
      INSERT INTO draft_events (draft_id, actor_id, event) SELECT id, ${input.actorId}::uuid, 'unapproved' FROM updated
    )
    SELECT id FROM updated`;
  return rows.length > 0;
}

/** Delete, only while status = 'draft'. Its dependency edges and events cascade. */
export async function deleteDraft(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(schema.drafts)
    .where(and(eq(schema.drafts.id, id), eq(schema.drafts.status, "draft")))
    .returning({ id: schema.drafts.id });
  return rows.length > 0;
}
