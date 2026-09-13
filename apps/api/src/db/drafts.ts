import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Draft as DraftDto, DraftStatus } from "@issue-pipeline/shared";
import { getDb, schema } from "./client";

/** Drafts for a repo (optionally one status), each with its dependencies. */
export async function listDrafts(filter: { repoId?: string; runId?: string; status?: DraftStatus }): Promise<DraftDto[]> {
  const db = getDb();
  const conditions: SQL[] = [];
  if (filter.repoId) conditions.push(eq(schema.drafts.repoId, filter.repoId));
  if (filter.runId) conditions.push(eq(schema.drafts.runId, filter.runId));
  if (filter.status) conditions.push(eq(schema.drafts.status, filter.status));

  const rows = await db
    .select()
    .from(schema.drafts)
    .where(and(...conditions))
    .orderBy(asc(schema.drafts.createdAt), asc(schema.drafts.title));
  if (rows.length === 0) return [];

  const target = alias(schema.drafts, "target");
  const deps = await db
    .select({
      draftId: schema.draftDeps.draftId,
      id: target.id,
      title: target.title,
      giteaNumber: target.giteaNumber,
    })
    .from(schema.draftDeps)
    .innerJoin(target, eq(schema.draftDeps.dependsOnId, target.id))
    .where(inArray(schema.draftDeps.draftId, rows.map((r) => r.id)));

  return rows.map((r) => ({
    id: r.id,
    run_id: r.runId,
    repo_id: r.repoId,
    title: r.title,
    body: r.body,
    template_name: r.templateName,
    labels: r.labels,
    status: r.status as DraftStatus,
    version: r.version,
    depends_on: deps
      .filter((d) => d.draftId === r.id)
      .map((d) => ({ id: d.id, title: d.title, gitea_number: d.giteaNumber })),
    gitea_number: r.giteaNumber,
    gitea_url: r.giteaUrl,
    created_at: r.createdAt.toISOString(),
  }));
}
