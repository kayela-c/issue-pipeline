import { and, asc, eq } from "drizzle-orm";
import type { Repo as RepoDto } from "@issue-pipeline/shared";
import type { ForgeLabel, TreeEntry } from "../forge/types";
import type { IssueTemplate } from "../pipeline/templates";
import { getDb, schema } from "./client";
import type { Repo, RepoSnapshot } from "./schema";

export const toRepoDto = (r: Repo): RepoDto => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  default_branch: r.defaultBranch,
  created_at: r.createdAt.toISOString(),
});

export function listRepos(): Promise<Repo[]> {
  return getDb().select().from(schema.repos).orderBy(asc(schema.repos.owner), asc(schema.repos.name));
}

export async function getRepoById(id: string): Promise<Repo | undefined> {
  const [row] = await getDb().select().from(schema.repos).where(eq(schema.repos.id, id));
  return row;
}

/** Track a repo; tracking one that is already tracked returns the existing row. */
export async function trackRepo(input: {
  owner: string;
  name: string;
  defaultBranch: string;
  addedBy: string;
}): Promise<{ repo: Repo; created: boolean }> {
  const db = getDb();
  const [inserted] = await db
    .insert(schema.repos)
    .values(input)
    .onConflictDoNothing({ target: [schema.repos.owner, schema.repos.name] })
    .returning();
  if (inserted) return { repo: inserted, created: true };

  const [existing] = await db
    .select()
    .from(schema.repos)
    .where(and(eq(schema.repos.owner, input.owner), eq(schema.repos.name, input.name)));
  if (!existing) throw new Error("repo vanished between insert and select");
  return { repo: existing, created: false };
}

export async function updateDefaultBranch(id: string, defaultBranch: string): Promise<void> {
  await getDb().update(schema.repos).set({ defaultBranch }).where(eq(schema.repos.id, id));
}

// --- Snapshots ---------------------------------------------------------------

export interface SnapshotData {
  tree: TreeEntry[];
  readme: string | null;
  /** ROUTING.md at the repository root, or null when the repository has none. */
  routing: string | null;
  templates: IssueTemplate[];
  labels: ForgeLabel[];
}

export async function getSnapshot(repoId: string, commitSha: string): Promise<SnapshotData | undefined> {
  const [row] = await getDb()
    .select()
    .from(schema.repoSnapshots)
    .where(and(eq(schema.repoSnapshots.repoId, repoId), eq(schema.repoSnapshots.commitSha, commitSha)));
  return row ? fromRow(row) : undefined;
}

export async function saveSnapshot(repoId: string, commitSha: string, data: SnapshotData): Promise<void> {
  await getDb()
    .insert(schema.repoSnapshots)
    .values({ repoId, commitSha, ...data })
    .onConflictDoNothing();
}

const fromRow = (row: RepoSnapshot): SnapshotData => ({
  tree: row.tree as TreeEntry[],
  readme: row.readme,
  routing: row.routing,
  templates: row.templates as IssueTemplate[],
  labels: row.labels as ForgeLabel[],
});
