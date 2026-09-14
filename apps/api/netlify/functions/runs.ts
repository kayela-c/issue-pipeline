import type { Config } from "@netlify/functions";
import type { RunResponse, RunStatus } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { failIfStale, getRunDetails } from "../../src/db/runs";
import { HttpError, json, requireUuid } from "../../src/http";

/** A background function is stopped after 15 minutes; allow a margin before calling a run dead. */
const STALE_AFTER_MS = 17 * 60 * 1000;

/** Run status for polling, with the ids of the drafts it produced. */
export default withAuth(async (_req, _auth, context) => {
  const runId = requireUuid(context.params.id, "Run");

  let details = await getRunDetails(runId);
  if (!details) throw new HttpError("not_found", "Run not found.");

  const { run } = details;
  if (!["done", "failed"].includes(run.status)) {
    await failIfStale(runId, new Date(Date.now() - STALE_AFTER_MS));
    details = (await getRunDetails(runId)) ?? details;
  }

  const r = details.run;
  const body: RunResponse = {
    id: r.id,
    repo_id: details.repoId,
    status: r.status as RunStatus,
    error: r.error,
    attempts: r.attempts,
    commit_sha: r.commitSha,
    raw_issue: details.rawIssue,
    draft_ids: details.draftIds,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    model_draft: r.modelDraft,
    app_template: r.templateSnapshot
      ? { name: r.templateSnapshot.name, file: r.templateSnapshot.file, kind: r.templateSnapshot.kind }
      : null,
    created_at: r.createdAt.toISOString(),
    started_at: r.startedAt?.toISOString() ?? null,
    finished_at: r.finishedAt?.toISOString() ?? null,
  };
  return json(body);
});

export const config: Config = { path: "/api/runs/:id", method: "GET" };
