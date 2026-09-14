import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRAFT_STATUSES, isTerminalRunStatus, type RunStatus, type RunSummary } from "@issue-pipeline/shared";
import { useEffect, useRef } from "react";
import { listRuns, retryRun } from "../lib/api";
import { linkHandler } from "../lib/router";
import { RunView } from "./RunView";

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  reading_repo: "Reading repo",
  selecting_files: "Choosing files",
  drafting: "Drafting",
  done: "Drafted",
  failed: "Failed",
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function statusClass(status: RunStatus): string {
  if (status === "failed") return "pill pill--bad";
  if (status === "done") return "pill pill--good";
  return "pill pill--active";
}

function DraftCounts({ drafts }: { drafts: RunSummary["drafts"] }) {
  const parts = DRAFT_STATUSES.filter((s) => (drafts[s] ?? 0) > 0).map((s) => `${drafts[s]} ${s}`);
  return parts.length > 0 ? <span className="muted small">{parts.join(" · ")}</span> : null;
}

function RunRow({ run, expanded }: { run: RunSummary; expanded: boolean }) {
  // Clicking an open row closes it; clicking another opens that one instead.
  const href = expanded ? "/queue" : `/queue/${run.id}`;
  const ref = useRef<HTMLLIElement>(null);
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryRun(run.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["run", run.id] });
    },
  });

  // Bring a run opened from elsewhere (e.g. just submitted) into view.
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);

  return (
    <li ref={ref} className={expanded ? "queue-item queue-item--open" : "queue-item"}>
      <a href={href} onClick={linkHandler(href)} className="queue-row" aria-expanded={expanded}>
        <div className="queue-main">
          <div>
            <span className={statusClass(run.status)}>{RUN_STATUS_LABEL[run.status]}</span>
            <strong>
              {run.repo.owner}/{run.repo.name}
            </strong>
          </div>
          {!expanded && <div className="queue-excerpt">{run.excerpt}</div>}
          {!expanded && run.status === "failed" && run.error && (
            <div className="status--bad small queue-error">{run.error}</div>
          )}
        </div>
        <div className="queue-side small">
          <span className="muted">
            {run.author.display_name || run.author.username} · {timeAgo(run.created_at)}
          </span>
          <DraftCounts drafts={run.drafts} />
        </div>
      </a>
      {!expanded && run.status === "failed" && (
        <div className="queue-row-actions">
          {retry.error && <span className="status status--bad small">{retry.error.message}</span>}
          <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {expanded && <RunView runId={run.id} />}
    </li>
  );
}

function RunList({ runs, selectedId }: { runs: RunSummary[]; selectedId?: string }) {
  return (
    <ul className="list">
      {runs.map((r) => (
        <RunRow key={r.id} run={r} expanded={r.id === selectedId} />
      ))}
    </ul>
  );
}

/**
 * Every submission moving through the workflow, newest first, with in-progress
 * runs on top. `/queue/<run id>` opens that run's progress and drafts in place.
 */
export function Queue({ selectedId }: { selectedId?: string }) {
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: listRuns,
    // Fast polling while anything is still running; slow otherwise.
    refetchInterval: (query) => (query.state.data?.some((r) => !isTerminalRunStatus(r.status)) ? 3_000 : 15_000),
  });

  const active = runs.data?.filter((r) => !isTerminalRunStatus(r.status)) ?? [];
  const finished = runs.data?.filter((r) => isTerminalRunStatus(r.status)) ?? [];
  // A run just submitted may not be in the list yet; show it on its own until it is.
  const selectedMissing = selectedId !== undefined && runs.data !== undefined && !runs.data.some((r) => r.id === selectedId);

  return (
    <>
      <section className="card">
        <h2>In progress {runs.data ? `(${active.length})` : ""}</h2>
        {runs.isPending && <p className="muted">Loading…</p>}
        {runs.error && <p className="status status--bad">Could not load the queue: {runs.error.message}</p>}
        {selectedMissing && <RunView runId={selectedId} />}
        {runs.data && active.length === 0 && !selectedMissing && <p className="muted">Nothing is drafting right now.</p>}
        {active.length > 0 && <RunList runs={active} selectedId={selectedId} />}
      </section>

      <section className="card">
        <h2>Recent</h2>
        {runs.data && finished.length === 0 && <p className="muted">No finished runs yet.</p>}
        {finished.length > 0 && <RunList runs={finished} selectedId={selectedId} />}
      </section>
    </>
  );
}
