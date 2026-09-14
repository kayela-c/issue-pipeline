import type { Config } from "@netlify/functions";
import { approveDraftRequestSchema } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { approveDraft, getDraftDetail, getDraftState } from "../../src/db/drafts";
import { HttpError, json, readJson, requireUuid } from "../../src/http";
import { refusal } from "../../src/pipeline/review";

/**
 * POST {version}: draft -> approved. The version is the one the approver
 * reviewed, so an approval never applies to content they have not seen.
 * Anyone in the org may approve, including the draft's author.
 */
export default withAuth(async (req, { user }, context) => {
  const id = requireUuid(context.params.id, "Draft");
  const { version } = await readJson(req, approveDraftRequestSchema);

  if (!(await approveDraft({ id, actorId: user.id, version }))) {
    throw refusal(await getDraftState(id), "draft", version);
  }
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return json(detail);
});

export const config: Config = { path: "/api/drafts/:id/approve", method: "POST" };
