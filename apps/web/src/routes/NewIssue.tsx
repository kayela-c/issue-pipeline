import { useMutation, useQuery } from "@tanstack/react-query";
import { RAW_ISSUE_MAX_LENGTH } from "@issue-pipeline/shared";
import { useState } from "react";
import { createRawIssue, listRepos } from "../lib/api";
import { linkHandler, navigate } from "../lib/router";

export function NewIssue() {
  const repos = useQuery({ queryKey: ["repos"], queryFn: listRepos });
  const [repoId, setRepoId] = useState("");
  const [body, setBody] = useState("");

  const selectedRepo = repoId || repos.data?.[0]?.id || "";

  const submit = useMutation({
    mutationFn: () => createRawIssue(selectedRepo, body),
    // Follow the run from the queue, where it opens expanded.
    onSuccess: (runId) => navigate(`/queue/${runId}`),
  });

  if (repos.data?.length === 0) {
    return (
      <section className="card">
        <h2>New issue</h2>
        <p className="muted">
          Track a repository first on the{" "}
          <a href="/repos" onClick={linkHandler("/repos")}>
            Repositories
          </a>{" "}
          page.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>New issue</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <label className="field">
          <span>Repository</span>
          <select value={selectedRepo} onChange={(e) => setRepoId(e.target.value)} disabled={repos.isPending}>
            {repos.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Rough notes</span>
          <textarea
            rows={12}
            maxLength={RAW_ISSUE_MAX_LENGTH}
            placeholder="Describe the bug, feature, or task in your own words. Paste errors, links, or half-formed ideas."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="muted small">
            {body.length.toLocaleString()} / {RAW_ISSUE_MAX_LENGTH.toLocaleString()}
          </span>
        </label>

        {submit.error && <p className="status status--bad">{submit.error.message}</p>}

        <button type="submit" disabled={!selectedRepo || !body.trim() || submit.isPending}>
          {submit.isPending ? "Starting…" : "Draft issues"}
        </button>
      </form>
    </section>
  );
}
