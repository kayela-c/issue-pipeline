import type { Config, Context } from "@netlify/functions";
import { z } from "zod";
import { withAuth } from "../../src/auth/withAuth";
import {
  claimDraftForPosting,
  findReadyDraftId,
  getDraftDetail,
  markDependencyLinked,
  markDraftFailed,
  markDraftPosted,
  recordLinkFailed,
} from "../../src/db/drafts";
import { repoAndForge } from "../../src/forge/forRepo";
import { apiError, json } from "../../src/http";
import { hasValidJobSecret } from "../../src/jobs";
import { postDraft } from "../../src/pipeline/post";

const bodySchema = z.object({ repo_id: z.uuid() });

const store = { claimDraftForPosting, getDraftDetail, markDraftPosted, markDraftFailed, markDependencyLinked, recordLinkFailed };

const MAX_POSTS = 50;
const MAX_CONSECUTIVE_FAILURES = 3;

const log = (message: string, detail: Record<string, unknown> = {}) => console.log(`[post-queue] ${message}`, detail);

/**
 * Post every ready draft in a repo, oldest first (background: Netlify answers
 * 202 and runs up to 15 min). Each draft is claimed atomically, so this can
 * run alongside someone posting a single draft by hand without a race.
 * Because each iteration re-checks readiness, dependencies post before their
 * dependents without an explicit topological sort.
 */
export default async (req: Request, context: Context) => {
  if (!hasValidJobSecret(req)) {
    return apiError("forbidden", "Forbidden.");
  }

  const text = await req.text();
  const parsed = bodySchema.safeParse(JSON.parse(text || "null"));
  if (!parsed.success) {
    return apiError("bad_request", "Expected {repo_id}.");
  }
  const repoId = parsed.data.repo_id;

  const handler = withAuth(async (_req, auth) => {
    const { user } = auth;
    // Gitea repos use the forwarded session token; GitHub repos load the triggering user's stored token.
    const { forge } = await repoAndForge(auth, repoId);
    let posted = 0;
    let consecutiveFailures = 0;

    while (posted < MAX_POSTS && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const draftId = await findReadyDraftId(repoId);
      if (!draftId) break;

      try {
        const result = await postDraft(draftId, user.id, forge, store);
        if (result.status === "posted") {
          posted++;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          log("draft did not post", { draftId, ...result });
        }
      } catch (err) {
        // Someone else claimed it (or another race) between the readiness
        // check and the claim attempt; move on rather than crash the batch.
        consecutiveFailures++;
        log("claim raced", { draftId, message: err instanceof Error ? err.message : String(err) });
      }
    }

    log("finished", { repoId, posted, consecutiveFailures });
    return json({ posted });
  });

  return handler(new Request(req.url, { method: req.method, headers: req.headers, body: text }), context);
};

export const config: Config = { path: "/internal/post-queue", method: "POST" };
