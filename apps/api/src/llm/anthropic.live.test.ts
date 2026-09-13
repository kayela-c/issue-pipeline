import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeTemplate, parseTemplate } from "../pipeline/templates";
import { normalizeDropdownAnswers, validateDrafts } from "../pipeline/validate";

/**
 * Opt-in live test of both Stage 1 calls against the configured provider
 * (LLM_PROVIDER: the Anthropic API costs a few cents; LM Studio is free): LIVE_LLM=1 pnpm --filter @issue-pipeline/api exec vitest run src/llm
 */
const live = process.env.LIVE_LLM === "1";
const envFile = new URL("../../../../.env", import.meta.url);
if (live && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

describe.skipIf(!live)("Anthropic client (live)", () => {
  const template = parseTemplate(
    ".gitea/ISSUE_TEMPLATE/feature-task.yml",
    readFileSync(new URL("../../../../feature-task.yml", import.meta.url), "utf8"),
  )!;

  const rawIssue =
    "Users can't reset their password - the reset email link 404s. Also we should rate limit the reset endpoint, it's getting hammered.";

  it("selects files and drafts valid issues for a form template", { timeout: 300_000 }, async () => {
    const { llmClientFromEnv } = await import("./index");
    const llm = llmClientFromEnv();

    const selection = await llm.selectFiles({
      repo: "TrueRoster/example",
      rawIssue,
      readmeExcerpt: "Laravel app with a Filament admin panel.",
      routing: "",
      fileList: [
        "app/Http/Controllers/Auth/PasswordResetController.php",
        "routes/web.php",
        "routes/api.php",
        "app/Providers/RouteServiceProvider.php",
        "resources/views/welcome.blade.php",
      ].join("\n"),
      shown: 5,
      total: 5,
    });
    expect(selection.paths.length).toBeGreaterThan(0);
    expect(selection.usage.inputTokens).toBeGreaterThan(0);

    const ctx = { labels: ["bug", "security"], templates: [template] };
    const conversation = await llm.draftIssues({
      repo: "TrueRoster/example",
      rawIssue,
      routing: "",
      files: '<file path="routes/web.php">\nRoute::get(\'/password/reset/{token}\', [PasswordResetController::class, \'show\']);\n</file>',
      templates: describeTemplate(template),
      labels: ctx.labels,
    });

    let output = normalizeDropdownAnswers(conversation.output, ctx.templates);
    let errors = validateDrafts(output, ctx);
    console.log("first pass", { drafts: output.drafts.length, errors, usage: conversation.usage });
    if (errors.length > 0) {
      const repaired = await conversation.repair(errors);
      output = normalizeDropdownAnswers(repaired.output, ctx.templates);
      errors = validateDrafts(output, ctx);
      console.log("after repair", { errors, usage: repaired.usage });
    }
    console.log(JSON.stringify(output, null, 2));
    expect(errors).toEqual([]);
  });
});
