import type { Config } from "@netlify/functions";
import { draftStatusSchema, type DraftListResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { listDrafts } from "../../src/db/drafts";
import { HttpError, json, requireUuid } from "../../src/http";

/** GET /api/drafts?repo_id=&run_id=&status= -- drafts with their dependencies. */
export default withAuth(async (req) => {
  const params = new URL(req.url).searchParams;
  const repoId = params.get("repo_id");
  const runId = params.get("run_id");
  if (!repoId && !runId) {
    throw new HttpError("bad_request", "Pass repo_id or run_id.");
  }

  const status = params.get("status");
  const parsedStatus = status === null ? undefined : draftStatusSchema.safeParse(status);
  if (parsedStatus && !parsedStatus.success) {
    throw new HttpError("bad_request", "Unknown draft status.");
  }

  const body: DraftListResponse = {
    drafts: await listDrafts({
      repoId: repoId ? requireUuid(repoId, "Repository", "bad_request") : undefined,
      runId: runId ? requireUuid(runId, "Run", "bad_request") : undefined,
      status: parsedStatus?.data,
    }),
  };
  return json(body);
});

export const config: Config = { path: "/api/drafts", method: "GET" };
