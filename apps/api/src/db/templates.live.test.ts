import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * App templates against the real database in DATABASE_URL (the Neon dev
 * branch). Opt-in: LIVE_DB=1 pnpm --filter @issue-pipeline/api test
 */
const live = process.env.LIVE_DB === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && !process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("templates store (live database)", async () => {
  const { getDb, schema } = await import("./client");
  const templates = await import("./templates");
  const runs = await import("./runs");
  const repos = await import("./repos");

  const suffix = randomUUID().slice(0, 8);
  const ids = { user: "", repo: "", template: "" };
  const input = {
    name: `Live test template ${suffix}`,
    forges: ["gitea" as const],
    kind: "markdown" as const,
    content: "## Summary\n",
  };

  beforeAll(async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ giteaId: -randomInt(1, 2 ** 31), username: `live-test-${suffix}` })
      .returning();
    ids.user = user!.id;
    const { repo } = await repos.trackRepo({ owner: "live-test", name: `repo-${suffix}`, defaultBranch: "main", addedBy: ids.user });
    ids.repo = repo.id;
  });

  afterAll(async () => {
    if (ids.template) await getDb().delete(schema.issueTemplates).where(eq(schema.issueTemplates.id, ids.template));
    if (!ids.repo) return;
    await getDb().delete(schema.rawIssues).where(eq(schema.rawIssues.repoId, ids.repo));
    await getDb().delete(schema.repos).where(eq(schema.repos.id, ids.repo));
    await getDb().delete(schema.users).where(eq(schema.users.id, ids.user));
  });

  it("creates a template and refuses a second one with the same name", async () => {
    const row = await templates.createTemplate(input, ids.user);
    ids.template = row.id;
    expect(row).toMatchObject({ name: input.name, forges: ["gitea"], version: 1, createdBy: ids.user });
    await expect(templates.createTemplate(input, ids.user)).rejects.toBeInstanceOf(templates.TemplateNameTaken);

    const [dto] = await templates.toTemplateDtos([row]);
    expect(dto).toMatchObject({ file: `live-test-template-${suffix}.md`, created_by: `live-test-${suffix}` });
  });

  it("updates only from the current version", async () => {
    const updated = await templates.updateTemplate(ids.template, 1, { ...input, content: "## Changed\n" }, ids.user);
    expect(updated).toMatchObject({ version: 2, content: "## Changed\n" });
    expect(await templates.updateTemplate(ids.template, 1, input, ids.user)).toBeUndefined();
  });

  it("copies the template onto a run, and the run keeps it after the template is deleted", async () => {
    const row = (await templates.getTemplate(ids.template))!;
    const runId = await runs.createRawIssueWithRun({
      repoId: ids.repo,
      authorId: ids.user,
      body: "Notes",
      template: templates.toTemplateSnapshot(row),
    });

    expect(await templates.deleteTemplate(ids.template)).toBe(true);
    ids.template = "";

    const claimed = await runs.claimRun(runId);
    expect(claimed!.run.templateSnapshot).toMatchObject({ name: input.name, content: "## Changed\n", version: 2, kind: "markdown" });
    const [rawIssue] = await getDb().select().from(schema.rawIssues).where(eq(schema.rawIssues.repoId, ids.repo));
    expect(rawIssue!.templateId).toBeNull();
  });
});
