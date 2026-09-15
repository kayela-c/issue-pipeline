import type { Config } from "@netlify/functions";
import { withAuth } from "../../src/auth/withAuth";
import { failRun, getRunDetails, requeueRun } from "../../src/db/runs";
import { repoAndForge } from "../../src/forge/forRepo";
import { HttpError, json, requireUuid } from "../../src/http";
import { triggerJob } from "../../src/jobs";

/** Retry a failed run: failed -> queued, then start the job again as the caller. */
export default withAuth(async (req, auth, context) => {
  const { giteaToken } = auth;
  const runId = requireUuid(context.params.id, "Run");

  // Refuse before requeueing when the caller cannot read the run's repo (e.g. GitHub not connected).
  const existing = await getRunDetails(runId);
  if (!existing) throw new HttpError("not_found", "Run not found.");
  await repoAndForge(auth, existing.repoId);

  if (!(await requeueRun(runId))) {
    const details = await getRunDetails(runId);
    if (!details) throw new HttpError("not_found", "Run not found.");
    throw new HttpError("conflict", `Only failed runs can be retried; this run is ${details.run.status}.`);
  }

  if (!(await triggerJob(req, "/internal/draft-run", { run_id: runId }, giteaToken))) {
    await failRun(runId, "The drafting job could not be started. Retry the run.");
  }
  return json({ run_id: runId }, 202);
});

export const config: Config = { path: "/api/runs/:id/retry", method: "POST" };
