import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTerminalRunStatus, type RunStatus } from "@issue-pipeline/shared";
import { useEffect } from "react";
import { getRun, listRunDrafts, retryRun } from "../lib/api";

const STEPS: Array<{ status: RunStatus; label: string }> = [
  { status: "queued", label: "Queued" },
  { status: "reading_repo", label: "Reading the repository" },
  { status: "selecting_files", label: "Choosing relevant files" },
  { status: "drafting", label: "Drafting issues" },
  { status: "done", label: "Done" },
];

/** A run's progress, details, and drafts, shown expanded inside its queue row. */
export function RunView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    // Poll every 2 s while the run is active (docs/ARCHITECTURE.md section 8).
    refetchInterval: (query) => (query.state.data && isTerminalRunStatus(query.state.data.status) ? false : 2_000),
  });
  const status = run.data?.status;
  const done = status === "done";
  const drafts = useQuery({
    queryKey: ["run-drafts", runId],
    queryFn: () => listRunDrafts(runId),
    enabled: done,
  });

  // Keep the queue rows in step with the detail view as the run advances.
  useEffect(() => {
    if (status) void queryClient.invalidateQueries({ queryKey: ["runs"] });
  }, [status, queryClient]);

  const retry = useMutation({
    mutationFn: () => retryRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });

  if (run.isPending) return <p className="muted small">Loading…</p>;
  if (run.error) return <p className="status status--bad">{run.error.message}</p>;

  const r = run.data;
  const currentIndex = STEPS.findIndex((s) => s.status === r.status);

  return (
    <div className="run-detail">
      {r.status === "failed" ? (
        <>
          <p className="status status--bad">
            <strong>Failed.</strong> {r.error}
          </p>
          {retry.error && <p className="status status--bad">{retry.error.message}</p>}
          <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? "Retrying…" : "Retry"}
          </button>
        </>
      ) : (
        <ol className="steps steps--inline">
          {STEPS.map((step, i) => (
            <li
              key={step.status}
              className={i < currentIndex || done ? "step step--done" : i === currentIndex ? "step step--active" : "step"}
            >
              {step.label}
            </li>
          ))}
        </ol>
      )}

      <dl className="meta">
        {r.commit_sha && (
          <>
            <dt>Commit</dt>
            <dd>{r.commit_sha.slice(0, 10)}</dd>
          </>
        )}
        {r.attempts > 1 && (
          <>
            <dt>Attempts</dt>
            <dd>{r.attempts}</dd>
          </>
        )}
        {r.model_draft && (
          <>
            <dt>Model</dt>
            <dd>{r.model_draft}</dd>
          </>
        )}
        {r.input_tokens !== null && (
          <>
            <dt>Tokens</dt>
            <dd>
              {r.input_tokens.toLocaleString()} in / {(r.output_tokens ?? 0).toLocaleString()} out
            </dd>
          </>
        )}
      </dl>

      <details>
        <summary className="muted small">Your notes</summary>
        <pre className="notes">{r.raw_issue}</pre>
      </details>

      {done && (
        <div className="run-drafts">
          <h3>Drafts {drafts.data ? `(${drafts.data.length})` : ""}</h3>
          {drafts.isPending && <p className="muted small">Loading…</p>}
          {drafts.error && <p className="status status--bad">{drafts.error.message}</p>}
          {drafts.data?.map((d) => (
            <article key={d.id} className="draft">
              <h4>{d.title}</h4>
              <p className="muted small">
                {d.template_name ?? "no template"}
                {d.labels.map((l) => (
                  <span key={l} className="badge">
                    {l}
                  </span>
                ))}
              </p>
              {d.depends_on.length > 0 && (
                <p className="small">Depends on: {d.depends_on.map((dep) => dep.title).join(", ")}</p>
              )}
              {/* Plain text for now: AI-written Markdown is never rendered as HTML. */}
              <pre className="body">{d.body}</pre>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
