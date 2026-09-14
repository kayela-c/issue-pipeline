import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AI_PROVIDERS,
  DRAFT_STATUSES,
  FORGES,
  RUN_STATUSES,
  TEMPLATE_CONTENT_MAX,
  TEMPLATE_KINDS,
  TEMPLATE_NAME_MAX,
  type TemplateKind,
} from "@issue-pipeline/shared";

/** An app template as copied onto a run. */
export interface TemplateSnapshot {
  id: string;
  name: string;
  file: string;
  kind: TemplateKind;
  content: string;
  version: number;
}

/**
 * Schema for the issue pipeline. Mirrors docs/ARCHITECTURE.md section 4.
 *
 * Statuses are text + CHECK rather than PG enums so that adding one is an
 * ALTER on the constraint instead of a type migration. The allowed values are
 * generated from the shared package, so the DB constraint and the API contract
 * cannot drift apart.
 */

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  giteaId: bigint("gitea_id", { mode: "number" }).notNull().unique(),
  username: text("username").notNull(),
  displayName: text("display_name"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
});

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    addedBy: uuid("added_by").references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [unique("repos_owner_name_key").on(t.owner, t.name)],
);

/** Cached repo read, keyed by commit so an unchanged repo is never re-read. */
export const repoSnapshots = pgTable(
  "repo_snapshots",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    /** [{ path, size }] after filtering. */
    tree: jsonb("tree").notNull(),
    readme: text("readme"),
    /** ROUTING.md at the repository root: the map of where each area of the system lives. */
    routing: text("routing"),
    /** Issue templates as they existed at this commit. */
    templates: jsonb("templates").notNull().default(sql`'[]'::jsonb`),
    /** [{ id, name }] */
    labels: jsonb("labels").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.commitSha] })],
);

/** Team-wide issue templates managed in Settings. */
export const issueTemplates = pgTable(
  "issue_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Forges the template is offered for. */
    forges: text("forges").array().notNull(),
    kind: text("kind").notNull(),
    /** Raw Markdown (with optional front matter) or YAML issue form. */
    content: text("content").notNull(),
    /** Optimistic concurrency for edits; bumped on every change. */
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("issue_templates_name_key").on(t.name),
    check("issue_templates_name_len", sql`length(${t.name}) BETWEEN 1 AND ${sql.raw(String(TEMPLATE_NAME_MAX))}`),
    check("issue_templates_kind_check", sql`${t.kind} IN (${inList(TEMPLATE_KINDS)})`),
    check("issue_templates_forges_check", sql`cardinality(${t.forges}) > 0 AND ${t.forges} <@ ARRAY[${inList(FORGES)}]::text[]`),
    check("issue_templates_content_len", sql`length(${t.content}) BETWEEN 1 AND ${sql.raw(String(TEMPLATE_CONTENT_MAX))}`),
  ],
);

export const rawIssues = pgTable(
  "raw_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    /** The app template picked when submitting, if any. The run keeps its own snapshot. */
    templateId: uuid("template_id").references(() => issueTemplates.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("raw_issues_body_len", sql`length(${t.body}) BETWEEN 1 AND 20000`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rawIssueId: uuid("raw_issue_id")
      .notNull()
      .references(() => rawIssues.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    commitSha: text("commit_sha"),
    promptVersion: text("prompt_version"),
    modelSelect: text("model_select"),
    modelDraft: text("model_draft"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /**
     * The app template this run drafts with, copied at submission so editing
     * or deleting the template never changes the run (retries included).
     * Null: the repository's own templates.
     */
    templateSnapshot: jsonb("template_snapshot").$type<TemplateSnapshot>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    check("runs_status_check", sql`${t.status} IN (${inList(RUN_STATUSES)})`),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    templateName: text("template_name"),
    labels: text("labels").array().notNull().default(sql`'{}'`),
    status: text("status").notNull().default("draft"),
    /** Optimistic concurrency for edits; bumped on every mutation. */
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    claimedBy: uuid("claimed_by").references(() => users.id),
    claimedAt: timestamptz("claimed_at"),
    giteaNumber: integer("gitea_number"),
    giteaUrl: text("gitea_url"),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("drafts_title_len", sql`length(${t.title}) BETWEEN 1 AND 255`),
    check(
      "drafts_status_check",
      sql`${t.status} IN (${inList(DRAFT_STATUSES)})`,
    ),
    // A posted draft must carry the issue number it was posted as.
    check(
      "drafts_posted_has_number",
      sql`${t.status} <> 'posted' OR ${t.giteaNumber} IS NOT NULL`,
    ),
    index("drafts_repo_status_idx").on(t.repoId, t.status),
  ],
);

export const draftDeps = pgTable(
  "draft_deps",
  {
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    dependsOnId: uuid("depends_on_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    linkedInGitea: boolean("linked_in_gitea").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.dependsOnId] }),
    check("draft_deps_no_self", sql`${t.draftId} <> ${t.dependsOnId}`),
  ],
);

export const draftEvents = pgTable("draft_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  draftId: uuid("draft_id")
    .notNull()
    .references(() => drafts.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").references(() => users.id),
  event: text("event").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** Which AI provider a user drafts with; a null provider (or no row) means the team default. */
export const userAiSettings = pgTable(
  "user_ai_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("user_ai_settings_provider_check", sql`${t.provider} IS NULL OR ${t.provider} IN (${inList(AI_PROVIDERS)})`),
  ],
);

/**
 * A user's models and optional own API key, per provider. The key is stored
 * only as AES-256-GCM ciphertext (src/crypto/credentials.ts) bound to this
 * user and provider; the last four characters are kept for display.
 */
export const userAiProviders = pgTable(
  "user_ai_providers",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    modelSelect: text("model_select"),
    modelDraft: text("model_draft"),
    apiKeyEnc: text("api_key_enc"),
    apiKeyLast4: text("api_key_last4"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    check("user_ai_providers_provider_check", sql`${t.provider} IN (${inList(AI_PROVIDERS)})`),
  ],
);

export type User = typeof users.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type RepoSnapshot = typeof repoSnapshots.$inferSelect;
export type RawIssue = typeof rawIssues.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftDep = typeof draftDeps.$inferSelect;
export type DraftEventRow = typeof draftEvents.$inferSelect;
export type UserAiProviderRow = typeof userAiProviders.$inferSelect;
export type IssueTemplateRow = typeof issueTemplates.$inferSelect;
