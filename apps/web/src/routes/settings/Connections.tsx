import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CONNECTABLE_FORGES, CONNECTABLE_FORGE_STATUS, FORGE_LABELS, type ConnectableForge } from "@issue-pipeline/shared";
import { disconnectForge, listConnections, startGithubLogin } from "../../lib/api";

const CONNECTIONS_KEY = ["settings", "connections"] as const;

/** Only forges with a wired sign-in flow get an enabled Connect button, regardless of the "coming soon" label. */
const CONNECT_HANDLERS: Partial<Record<ConnectableForge, () => void>> = {
  github: () => startGithubLogin("/settings/connections"),
};

/**
 * Forge accounts linked to your one app account (decision 22). Each can sign
 * you in, and GitHub also grants access to your GitHub repositories (Phase 9).
 */
export function Connections() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: CONNECTIONS_KEY, queryFn: listConnections });
  const disconnect = useMutation({
    mutationFn: disconnectForge,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
  });

  if (connections.isPending) return <p className="muted">Loading…</p>;
  if (connections.error) return <p className="status status--bad">{connections.error.message}</p>;

  const linked = new Map(connections.data.map((c) => [c.forge, c]));

  return (
    <section className="card">
      <h2>Connections</h2>
      <p className="muted small">
        Each linked account signs you in to this same app account. Connecting GitHub also lets you track, draft for, and post
        to your GitHub repositories.
      </p>
      <div className="choice-list">
        {CONNECTABLE_FORGES.map((forge) => {
          const connection = linked.get(forge);
          const comingSoon = CONNECTABLE_FORGE_STATUS[forge] === "coming_soon";
          return (
            <div key={forge} className="choice choice--row">
              <span>
                <strong>{FORGE_LABELS[forge]}</strong>
                {connection && <span className="muted small"> · linked as {connection.username}</span>}
                {connection && !connection.repo_access && (
                  <span className="muted small"> · no repository access yet, reconnect to grant it</span>
                )}
                {comingSoon && !connection && <span className="muted small"> · coming soon</span>}
              </span>
              {connection ? (
                <span className="actions">
                  {!connection.repo_access && CONNECT_HANDLERS[forge] && (
                    <button type="button" onClick={CONNECT_HANDLERS[forge]}>
                      Reconnect
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => disconnect.mutate(forge)}
                    disabled={disconnect.isPending}
                  >
                    Disconnect
                  </button>
                </span>
              ) : (
                <button type="button" onClick={CONNECT_HANDLERS[forge]} disabled={!CONNECT_HANDLERS[forge]}>
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
      {disconnect.error && <p className="status status--bad">{disconnect.error.message}</p>}
    </section>
  );
}
