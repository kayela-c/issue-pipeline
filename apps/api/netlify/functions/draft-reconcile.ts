import type { Config } from "@netlify/functions";
import type { DraftDetail } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import {
  getDraftDetail,
  getReconcileContext,
  markDependencyLinked,
  reconcileToApproved,
  reconcileToPosted,
  recordLinkFailed,
  recordReconciledLinks,
} from "../../src/db/drafts";
import { HttpError, json, requireUuid } from "../../src/http";
import { reconcileDraft } from "../../src/pipeline/post";

const store = {
  getReconcileContext,
  reconcileToPosted,
  reconcileToApproved,
  markDependencyLinked,
  recordLinkFailed,
  recordReconciledLinks,
};

async function detailOrThrow(id: string): Promise<DraftDetail> {
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return detail;
}

/**
 * POST: resolve a `posting` stuck for over 5 minutes by searching Gitea for
 * the draft's marker, or retry unlinked dependency links on a `posted` draft
 * (docs/ARCHITECTURE.md section 7).
 */
export default withAuth(async (_req, { user, forge }, context) => {
  const id = requireUuid(context.params.id, "Draft");
  await reconcileDraft(id, user.id, forge, store);
  return json(await detailOrThrow(id));
});

export const config: Config = { path: "/api/drafts/:id/reconcile", method: "POST" };
