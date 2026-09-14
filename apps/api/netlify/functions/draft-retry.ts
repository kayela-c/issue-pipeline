import type { Config } from "@netlify/functions";
import type { DraftDetail } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { getDraftDetail, getDraftState, retryFailedDraft } from "../../src/db/drafts";
import { HttpError, json, requireUuid } from "../../src/http";
import { refusal } from "../../src/pipeline/review";

async function detailOrThrow(id: string): Promise<DraftDetail> {
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return detail;
}

/** POST: failed -> approved, so the team can retry posting without re-reviewing content. */
export default withAuth(async (_req, _auth, context) => {
  const id = requireUuid(context.params.id, "Draft");
  if (!(await retryFailedDraft(id))) {
    throw refusal(await getDraftState(id), "failed");
  }
  return json(await detailOrThrow(id));
});

export const config: Config = { path: "/api/drafts/:id/retry", method: "POST" };
