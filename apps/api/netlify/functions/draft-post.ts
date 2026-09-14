import type { Config } from "@netlify/functions";
import type { DraftDetail } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import {
  claimDraftForPosting,
  getDraftDetail,
  markDependencyLinked,
  markDraftFailed,
  markDraftPosted,
  recordLinkFailed,
} from "../../src/db/drafts";
import { HttpError, json, requireUuid } from "../../src/http";
import { postDraft } from "../../src/pipeline/post";

const store = { claimDraftForPosting, getDraftDetail, markDraftPosted, markDraftFailed, markDependencyLinked, recordLinkFailed };

async function detailOrThrow(id: string): Promise<DraftDetail> {
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return detail;
}

/**
 * POST: post one approved draft as a Gitea issue now (docs/ARCHITECTURE.md
 * section 7). This only throws when the claim itself is refused; every other
 * outcome (posted, left `posting` for reconcile, or failed) is persisted and
 * shows up in the draft returned here.
 */
export default withAuth(async (_req, { user, forge }, context) => {
  const id = requireUuid(context.params.id, "Draft");
  await postDraft(id, user.id, forge, store);
  return json(await detailOrThrow(id));
});

export const config: Config = { path: "/api/drafts/:id/post", method: "POST" };
