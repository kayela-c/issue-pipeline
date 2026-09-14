import type { Config } from "@netlify/functions";
import { FORGE_LABELS, createRawIssueRequestSchema, type CreateRawIssueResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getRepoById } from "../../src/db/repos";
import { countRunsSince, createRawIssueWithRun, failRun } from "../../src/db/runs";
import { getTemplate, toTemplateSnapshot } from "../../src/db/templates";
import { repoForge } from "../../src/settings/templates";
import { HttpError, json, readJson } from "../../src/http";
import { triggerJob } from "../../src/jobs";

const DAY_MS = 24 * 60 * 60 * 1000;

function dailyRunLimit(): number {
  const n = Number(process.env.MAX_RUNS_PER_USER_PER_DAY ?? "50");
  return Number.isInteger(n) && n > 0 ? n : 50;
}

/** Submit raw issue notes for a tracked repo and start drafting. */
export default withAuth(async (req, { user, giteaToken }) => {
  const { repo_id, body, template_id } = await readJson(req, createRawIssueRequestSchema);

  const repo = await getRepoById(repo_id);
  if (!repo) {
    throw new HttpError("not_found", "That repository is not tracked.");
  }

  // Copy the chosen app template now, so later edits never change this run or its retries.
  let template;
  if (template_id) {
    const row = await getTemplate(template_id);
    if (!row) throw new HttpError("not_found", "That template no longer exists. Choose another.");
    const forge = repoForge(repo);
    if (!row.forges.includes(forge)) {
      throw new HttpError("bad_request", `The template "${row.name}" is not offered for ${FORGE_LABELS[forge]} repositories.`);
    }
    template = toTemplateSnapshot(row);
  }

  const limit = dailyRunLimit();
  if ((await countRunsSince(user.id, new Date(Date.now() - DAY_MS))) >= limit) {
    throw new HttpError("rate_limited", `You have reached the limit of ${limit} drafting runs in 24 hours.`);
  }

  const runId = await createRawIssueWithRun({ repoId: repo_id, authorId: user.id, body, template });
  if (!(await triggerJob(req, "/internal/draft-run", { run_id: runId }, giteaToken))) {
    await failRun(runId, "The drafting job could not be started. Retry the run.");
  }

  const response: CreateRawIssueResponse = { run_id: runId };
  return json(response, 201);
});

export const config: Config = { path: "/api/raw-issues", method: "POST" };
