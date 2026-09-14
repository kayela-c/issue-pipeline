import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listRepos, postQueue } from "../lib/api";
import { setSearchParam, useSearchParam } from "../lib/router";
import { Board } from "./Board";
import { Queue } from "./Queue";

/** Queue and Board, stacked on one page, sharing a repo filter and "Post all ready". */
export function Workflow({ selectedRunId }: { selectedRunId?: string }) {
  const repoId = useSearchParam("repo") ?? "";
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ["repos"], queryFn: listRepos });
  const postReady = useMutation({
    mutationFn: () => postQueue(repoId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["drafts", repoId] }),
  });

  return (
    <>
      <div className="board-toolbar">
        <label className="board-filter">
          <span className="muted small">Repository</span>
          <select value={repoId} onChange={(e) => setSearchParam("repo", e.target.value || null)} disabled={repos.isPending}>
            <option value="">All repositories</option>
            {repos.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </label>
        {repoId && (
          <button type="button" onClick={() => postReady.mutate()} disabled={postReady.isPending}>
            {postReady.isPending ? "Posting…" : "Post all ready"}
          </button>
        )}
      </div>
      {postReady.error && <p className="status status--bad">{postReady.error.message}</p>}

      <h2 className="workflow-section-title">Queue</h2>
      <Queue selectedId={selectedRunId} />

      <h2 className="workflow-section-title">Board</h2>
      <Board repoId={repoId} />
    </>
  );
}
