import type { MeResponse } from "@issue-pipeline/shared";
import { startLogin } from "../lib/api";
import { useLogout } from "../lib/auth";
import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { linkHandler, replace, usePathname } from "../lib/router";
import { DraftEditor } from "./DraftEditor";
import { NewIssue } from "./NewIssue";
import { Repos } from "./Repos";
import { Settings } from "./Settings";
import { Workflow } from "./Workflow";

const NAV = [
  { path: "/queue", label: "Queue" },
  { path: "/repos", label: "Repositories" },
  { path: "/settings/ai", label: "Settings" },
];

export function Home({ me }: { me: MeResponse }) {
  const logout = useLogout();
  const pathname = usePathname();
  const [showNewIssue, setShowNewIssue] = useState(false);
  // /queue and /queue/<run id>; older /runs/<run id> links land here too.
  const queueMatch = pathname.match(/^\/(queue|runs)(?:\/([0-9a-f-]{36}))?$/i);
  const selectedRunId = queueMatch?.[2];
  const draftId = pathname.match(/^\/drafts\/([0-9a-f-]{36})$/i)?.[1];
  const isSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const section = pathname === "/repos" ? "/repos" : isSettings ? "/settings/ai" : "/queue";

  // Old links: /runs -> /queue, /board -> /queue (repo filter preserved), / -> /queue (New issue is now a modal).
  useEffect(() => {
    if (pathname.startsWith("/runs")) replace(selectedRunId ? `/queue/${selectedRunId}` : "/queue");
    else if (pathname === "/board") replace(`/queue${window.location.search}`);
    else if (pathname === "/") replace("/queue");
    setShowNewIssue(false);
  }, [pathname, selectedRunId]);

  return (
    <>
      <nav className="nav">
        {NAV.map((item) => (
          <a
            key={item.path}
            href={item.path}
            onClick={linkHandler(item.path)}
            aria-current={section === item.path ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
        <button type="button" className="primary" onClick={() => setShowNewIssue(true)}>
          New issue
        </button>
        <span className="nav-user muted small">
          {me.display_name || me.username}
          <button type="button" className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </span>
      </nav>

      {queueMatch ? (
        <Workflow selectedRunId={selectedRunId} />
      ) : draftId ? (
        <DraftEditor key={draftId} draftId={draftId} />
      ) : pathname === "/repos" ? (
        <Repos />
      ) : isSettings ? (
        <Settings pathname={pathname} />
      ) : (
        <Workflow />
      )}

      {showNewIssue && (
        <Modal label="New issue" onClose={() => setShowNewIssue(false)}>
          <NewIssue />
        </Modal>
      )}
    </>
  );
}

/**
 * Shown instead of the app when the signed-in account has no Gitea link
 * (decision 22: an account created directly by GitHub sign-in). Every
 * tracked repo lives on Gitea, so there is nothing to do here yet.
 */
export function ConnectGitea({ username }: { username: string }) {
  const logout = useLogout();
  const [redirecting, setRedirecting] = useState(false);

  const connect = () => {
    setRedirecting(true);
    startLogin("/");
  };

  return (
    <section className="card">
      <h2>Connect Gitea to continue</h2>
      <p className="muted spaced">
        Signed in as <strong>{username}</strong>. Access to this app is checked through your Gitea organization membership, so
        connect your Gitea account to continue. After that you can work with both Gitea and GitHub repositories.
      </p>
      <div className="actions">
        <button type="button" onClick={connect} disabled={redirecting}>
          {redirecting ? "Opening Gitea…" : "Connect Gitea"}
        </button>
        <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </div>
    </section>
  );
}

export function NoAccess({ message }: { message: string }) {
  const logout = useLogout();

  return (
    <section className="card">
      <h2>No access</h2>
      <p className="status status--bad">
        {message} Ask an org owner to add you, or sign in with a different account.
      </p>
      <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
        Sign out
      </button>
    </section>
  );
}
