import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FORGE_LABELS, REPO_FORGES, type RepoForge } from "@issue-pipeline/shared";
import { useEffect, useState } from "react";
import { isNotConnected, listRepos, searchForgeRepos, trackRepo } from "../lib/api";
import { linkHandler } from "../lib/router";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function Repos() {
  const queryClient = useQueryClient();
  const tracked = useQuery({ queryKey: ["repos"], queryFn: listRepos });
  const [forge, setForge] = useState<RepoForge>("gitea");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query.trim(), 300);
  const search = useQuery({
    queryKey: ["forge-repos", forge, debouncedQuery],
    queryFn: () => searchForgeRepos(forge, debouncedQuery),
    staleTime: 30_000,
    // "Connect GitHub first" will not fix itself by retrying.
    retry: (count, error) => !isNotConnected(error) && count < 2,
  });

  const track = useMutation({
    mutationFn: ({ owner, name }: { owner: string; name: string }) => trackRepo(forge, owner, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repos"] }),
  });

  const trackedNames = new Set((tracked.data ?? []).map((r) => `${r.forge}:${r.owner}/${r.name}`));
  const label = FORGE_LABELS[forge];

  return (
    <>
      <section className="card">
        <h2>Tracked repositories</h2>
        {tracked.isPending && <p className="muted">Loading…</p>}
        {tracked.error && <p className="status status--bad">{tracked.error.message}</p>}
        {tracked.data?.length === 0 && <p className="muted">No repositories yet. Track one below.</p>}
        {tracked.data && tracked.data.length > 0 && (
          <ul className="list">
            {tracked.data.map((r) => (
              <li key={r.id}>
                <strong>
                  {r.owner}/{r.name}
                </strong>
                <span className="badge">{FORGE_LABELS[r.forge]}</span>
                <span className="muted small"> · {r.default_branch}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Track a repository</h2>
        <div className="choice-list choice-list--inline" role="radiogroup" aria-label="Forge">
          {REPO_FORGES.map((f) => (
            <label key={f} className="choice">
              <input
                type="radio"
                name="repo-forge"
                checked={forge === f}
                onChange={() => {
                  setForge(f);
                  track.reset();
                }}
              />
              <span>{FORGE_LABELS[f]}</span>
            </label>
          ))}
        </div>
        <input
          type="search"
          placeholder={`Search your ${label} repositories`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Search ${label} repositories`}
        />
        {track.error && <p className="status status--bad spaced">{track.error.message}</p>}
        {search.isPending && <p className="muted spaced">Searching…</p>}
        {search.error && isNotConnected(search.error) && (
          <p className="status status--bad spaced">
            Connect {label} with repository access in{" "}
            <a href="/settings/connections" onClick={linkHandler("/settings/connections")}>
              Settings &gt; Connections
            </a>{" "}
            to see your {label} repositories.
          </p>
        )}
        {search.error && !isNotConnected(search.error) && <p className="status status--bad spaced">{search.error.message}</p>}
        {search.data?.length === 0 && <p className="muted spaced">No repositories match.</p>}
        {search.data && search.data.length > 0 && (
          <ul className="list">
            {search.data.map((r) => {
              const isTracked = trackedNames.has(`${forge}:${r.full_name}`);
              const unusable = r.archived || !r.has_issues;
              return (
                <li key={r.full_name} className="row">
                  <div>
                    <strong>{r.full_name}</strong>
                    {r.private && <span className="badge">private</span>}
                    {r.archived && <span className="badge">archived</span>}
                    {!r.has_issues && <span className="badge">issues off</span>}
                    {r.description && <div className="muted small">{r.description}</div>}
                  </div>
                  <button
                    type="button"
                    disabled={isTracked || unusable || track.isPending}
                    onClick={() => track.mutate({ owner: r.owner, name: r.name })}
                  >
                    {isTracked ? "Tracked" : "Track"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
