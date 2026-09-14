import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRAFT_STATUSES, type Draft, type DraftStatus } from "@issue-pipeline/shared";
import { listDrafts, listRepos, postQueue } from "../lib/api";
import { linkHandler, replace, useSearchParam } from "../lib/router";

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  posting: "Posting",
  posted: "Posted",
  failed: "Failed",
};

function DraftCard({ draft, showRepo }: { draft: Draft; showRepo: boolean }) {
  const href = `/drafts/${draft.id}`;
  const blockedBy = draft.depends_on.filter((d) => d.status !== "posted");
  return (
    <li>
      <a href={href} onClick={linkHandler(href)} className="board-card">
        <span className="board-card-title">{draft.title}</span>
        {showRepo && (
          <span className="muted small">
            {draft.repo.owner}/{draft.repo.name}
          </span>
        )}
        {draft.labels.length > 0 && (
          <span className="board-card-labels">
            {draft.labels.map((l) => (
              <span key={l} className="badge">
                {l}
              </span>
            ))}
          </span>
        )}
        {blockedBy.length > 0 && (
          <span className="muted small">
            Blocked by {blockedBy.length} unposted {blockedBy.length === 1 ? "draft" : "drafts"}
          </span>
        )}
        {draft.gitea_number !== null && <span className="small">#{draft.gitea_number}</span>}
        {draft.approved_by && draft.status === "approved" && (
          <span className="muted small">Approved by {draft.approved_by}</span>
        )}
      </a>
    </li>
  );
}

/** Drafts in columns by status, for one repo or all of them. */
export function Board() {
  const repoId = useSearchParam("repo") ?? "";
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ["repos"], queryFn: listRepos });
  const drafts = useQuery({
    queryKey: ["drafts", repoId],
    queryFn: () => listDrafts({ repoId: repoId || undefined }),
    // Every 10 s while visible, every 2 s while anything is posting.
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === "posting") ? 2_000 : 10_000),
    refetchIntervalInBackground: false,
  });
  const postReady = useMutation({
    mutationFn: () => postQueue(repoId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["drafts", repoId] }),
  });

  const byStatus = new Map<DraftStatus, Draft[]>(DRAFT_STATUSES.map((s) => [s, []]));
  for (const d of drafts.data ?? []) byStatus.get(d.status)?.push(d);

  return (
    <section className="board">
      <div className="board-toolbar">
        <label className="board-filter">
          <span className="muted small">Repository</span>
          <select
            value={repoId}
            onChange={(e) => replace(e.target.value ? `/board?repo=${e.target.value}` : "/board")}
            disabled={repos.isPending}
          >
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
        {drafts.isFetching && <span className="muted small">Refreshing…</span>}
      </div>

      {drafts.error && <p className="status status--bad">Could not load drafts: {drafts.error.message}</p>}
      {postReady.error && <p className="status status--bad">{postReady.error.message}</p>}

      <div className="board-columns">
        {DRAFT_STATUSES.map((status) => {
          const items = byStatus.get(status) ?? [];
          return (
            <div key={status} className="board-column">
              <h2>
                {DRAFT_STATUS_LABEL[status]} <span className="muted">{drafts.data ? items.length : ""}</span>
              </h2>
              {drafts.isPending && <p className="muted small">Loading…</p>}
              {drafts.data && items.length === 0 && <p className="muted small">None</p>}
              <ul className="board-list">
                {items.map((d) => (
                  <DraftCard key={d.id} draft={d} showRepo={!repoId} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
