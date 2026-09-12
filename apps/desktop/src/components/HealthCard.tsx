import { useQuery } from "@tanstack/react-query";
import { getHealth } from "../lib/api";

/**
 * Phase 0 stand-in for the real UI: proves the whole chain is wired --
 * React -> invoke -> Rust -> Netlify function -> Neon.
 */
export function HealthCard() {
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    retry: false,
  });

  return (
    <section className="card">
      <h2>API connection</h2>

      {isPending && <p className="muted">Checking…</p>}

      {error && (
        <p className="status status--bad">
          <strong>Unreachable.</strong> {error.message}
        </p>
      )}

      {data && (
        <>
          <p
            className={
              data.db === "ok" ? "status status--good" : "status status--bad"
            }
          >
            <strong>Database:</strong> {data.db}
          </p>
          <dl className="meta">
            <dt>Server time</dt>
            <dd>{new Date(data.now).toLocaleString()}</dd>
            <dt>Version</dt>
            <dd>{data.version}</dd>
          </dl>
        </>
      )}

      <button type="button" onClick={() => void refetch()} disabled={isFetching}>
        {isFetching ? "Checking…" : "Check again"}
      </button>
    </section>
  );
}
