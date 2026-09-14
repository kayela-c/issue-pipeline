import type { Forge, IssueTemplateDto, TemplateKind } from "@issue-pipeline/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appTemplateFile } from "../pipeline/templates";
import { getDb, schema } from "./client";
import type { IssueTemplateRow, TemplateSnapshot } from "./schema";

export interface TemplateInput {
  name: string;
  forges: Forge[];
  kind: TemplateKind;
  content: string;
}

/** Postgres unique_violation, wherever the driver or Drizzle put the code. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return true;
  }
  return false;
}

export class TemplateNameTaken extends Error {
  constructor(name: string) {
    super(`A template named "${name}" already exists.`);
    this.name = "TemplateNameTaken";
  }
}

export async function listTemplates(): Promise<IssueTemplateRow[]> {
  return getDb().select().from(schema.issueTemplates).orderBy(asc(schema.issueTemplates.name));
}

export async function getTemplate(id: string): Promise<IssueTemplateRow | undefined> {
  const [row] = await getDb().select().from(schema.issueTemplates).where(eq(schema.issueTemplates.id, id));
  return row;
}

export async function createTemplate(input: TemplateInput, userId: string): Promise<IssueTemplateRow> {
  try {
    const [row] = await getDb()
      .insert(schema.issueTemplates)
      .values({ ...input, createdBy: userId, updatedBy: userId })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateNameTaken(input.name);
    throw err;
  }
}

/** Guarded on `version`; undefined when the template is gone or someone else saved first. */
export async function updateTemplate(
  id: string,
  version: number,
  input: TemplateInput,
  userId: string,
): Promise<IssueTemplateRow | undefined> {
  try {
    const [row] = await getDb()
      .update(schema.issueTemplates)
      .set({
        ...input,
        updatedBy: userId,
        version: sql`${schema.issueTemplates.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.issueTemplates.id, id), eq(schema.issueTemplates.version, version)))
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateNameTaken(input.name);
    throw err;
  }
}

/** Runs keep their own snapshot, so deleting never changes a run. */
export async function deleteTemplate(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(schema.issueTemplates)
    .where(eq(schema.issueTemplates.id, id))
    .returning({ id: schema.issueTemplates.id });
  return rows.length > 0;
}

export const templateFile = (row: Pick<IssueTemplateRow, "name" | "kind">) =>
  appTemplateFile(row.name, row.kind as TemplateKind);

export function toTemplateSnapshot(row: IssueTemplateRow): TemplateSnapshot {
  return {
    id: row.id,
    name: row.name,
    file: templateFile(row),
    kind: row.kind as TemplateKind,
    content: row.content,
    version: row.version,
  };
}

/** DTOs with the creator's and last editor's usernames. */
export async function toTemplateDtos(rows: IssueTemplateRow[]): Promise<IssueTemplateDto[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]).filter((id): id is string => id !== null))];
  const users =
    ids.length === 0
      ? []
      : await getDb()
          .select({ id: schema.users.id, username: schema.users.username })
          .from(schema.users)
          .where(inArray(schema.users.id, ids));
  const username = new Map(users.map((u) => [u.id, u.username]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    forges: row.forges as Forge[],
    kind: row.kind as TemplateKind,
    content: row.content,
    file: templateFile(row),
    version: row.version,
    created_by: row.createdBy ? (username.get(row.createdBy) ?? null) : null,
    updated_by: row.updatedBy ? (username.get(row.updatedBy) ?? null) : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }));
}
