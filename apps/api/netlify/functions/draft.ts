import type { Config } from "@netlify/functions";
import { updateDraftRequestSchema, type DraftDetail } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import { deleteDraft, getDraftDetail, getDraftState, updateDraftContent } from "../../src/db/drafts";
import { getRepoById } from "../../src/db/repos";
import { HttpError, json, readJson, requireUuid } from "../../src/http";
import { refusal } from "../../src/pipeline/review";

async function detailOrThrow(id: string): Promise<DraftDetail> {
  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return detail;
}

/**
 * GET: draft with dependencies, dependents, and history.
 * PATCH {title?, body?, labels?, version}: edit, only while status is "draft".
 * DELETE: remove, only while status is "draft".
 */
export default withAuth(async (req, { user, forge }, context) => {
  const id = requireUuid(context.params.id, "Draft");

  if (req.method === "GET") {
    return json(await detailOrThrow(id));
  }

  if (req.method === "DELETE") {
    if (!(await deleteDraft(id))) throw refusal(await getDraftState(id), "draft");
    return new Response(null, { status: 204 });
  }

  const patch = await readJson(req, updateDraftRequestSchema);

  if (patch.labels !== undefined) {
    const state = await getDraftState(id);
    if (!state) throw new HttpError("not_found", "Draft not found.");
    const repo = await getRepoById(state.repoId);
    if (!repo) throw new HttpError("not_found", "The draft's repository is no longer tracked.");
    const known = new Set((await forge.listLabels(repo.owner, repo.name)).map((l) => l.name));
    const unknown = patch.labels.filter((l) => !known.has(l));
    if (unknown.length > 0) {
      throw new HttpError("bad_request", `Unknown labels for ${repo.owner}/${repo.name}: ${unknown.join(", ")}.`);
    }
  }

  const changed = await updateDraftContent({
    id,
    actorId: user.id,
    version: patch.version,
    title: patch.title,
    body: patch.body,
    labels: patch.labels === undefined ? undefined : [...new Set(patch.labels)],
  });
  if (!changed) throw refusal(await getDraftState(id), "draft", patch.version);
  return json(await detailOrThrow(id));
});

export const config: Config = { path: "/api/drafts/:id", method: ["GET", "PATCH", "DELETE"] };
