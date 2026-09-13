import type { Config } from "@netlify/functions";
import type { RunListResponse } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { listRuns } from "../../src/db/runs";
import { json } from "../../src/http";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** GET /api/runs?limit= -- the team's workflow queue, newest first. */
export default withAuth(async (req) => {
  const requested = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
  const body: RunListResponse = { runs: await listRuns(limit) };
  return json(body);
});

export const config: Config = { path: "/api/runs", method: "GET" };
