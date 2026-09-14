import type { Config } from "@netlify/functions";
import { withAuth } from "../../src/auth/withAuth";
import { getDraftDetail, getDraftState, unapproveDraft } from "../../src/db/drafts";
import { HttpError, json, requireUuid } from "../../src/http";
import { refusal } from "../../src/pipeline/review";

/** POST: approved -> draft, making the draft editable again. */
export default withAuth(async (_req, { user }, context) => {
  const id = requireUuid(context.params.id, "Draft");

  if (!(await unapproveDraft({ id, actorId: user.id }))) {
    throw refusal(await getDraftState(id), "approved");
  }
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return json(detail);
});

export const config: Config = { path: "/api/drafts/:id/unapprove", method: "POST" };
