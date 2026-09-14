import type { Config } from "@netlify/functions";
import { updateDepsRequestSchema } from "@issue-pipeline/shared";
import { withAuth } from "../../src/auth/withAuth";
import {
  DependencyCycleError,
  getDraftDetail,
  getDraftRepos,
  getDraftState,
  listDrafts,
  replaceDependencies,
  repoDependencyEdges,
} from "../../src/db/drafts";
import { HttpError, json, readJson, requireUuid } from "../../src/http";
import { checkDependencies, refusal } from "../../src/pipeline/review";

/** PUT {depends_on_ids, version}: replace a draft's dependencies (same repo, acyclic). */
export default withAuth(async (req, { user }, context) => {
  const id = requireUuid(context.params.id, "Draft");
  const { depends_on_ids, version } = await readJson(req, updateDepsRequestSchema);

  const state = await getDraftState(id);
  if (!state) throw new HttpError("not_found", "Draft not found.");
  if (state.status !== "draft" || state.version !== version) throw refusal(state, "draft", version);

  const [targets, edges, repoDrafts] = await Promise.all([
    getDraftRepos(depends_on_ids),
    repoDependencyEdges(state.repoId),
    listDrafts({ repoId: state.repoId }),
  ]);
  const problem = checkDependencies({
    draftId: id,
    repoId: state.repoId,
    dependsOnIds: depends_on_ids,
    targets,
    edges,
    titles: new Map(repoDrafts.map((d) => [d.id, d.title])),
  });
  if (problem) throw new HttpError("bad_request", problem);

  let changed: boolean;
  try {
    changed = await replaceDependencies({ id, actorId: user.id, version, dependsOnIds: depends_on_ids });
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      throw new HttpError("conflict", "Another change just made this a dependency cycle. Reload and try again.");
    }
    throw err;
  }
  if (!changed) throw refusal(await getDraftState(id), "draft", version);

  const detail = await getDraftDetail(id);
  if (!detail) throw new HttpError("not_found", "Draft not found.");
  return json(detail);
});

export const config: Config = { path: "/api/drafts/:id/deps", method: "PUT" };
