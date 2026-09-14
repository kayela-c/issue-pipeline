import type { MeResponse } from "@issue-pipeline/shared";
import { useLogout } from "../lib/auth";
import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { linkHandler, replace, usePathname } from "../lib/router";
import { DraftEditor } from "./DraftEditor";
import { NewIssue } from "./NewIssue";
import { Repos } from "./Repos";
import { Workflow } from "./Workflow";

const NAV = [
  { path: "/queue", label: "Queue" },
  { path: "/repos", label: "Repositories" },
];

export function Home({ me }: { me: MeResponse }) {
  const logout = useLogout();
  const pathname = usePathname();
  const [showNewIssue, setShowNewIssue] = useState(false);
  // /queue and /queue/<run id>; older /runs/<run id> links land here too.
  const queueMatch = pathname.match(/^\/(queue|runs)(?:\/([0-9a-f-]{36}))?$/i);
  const selectedRunId = queueMatch?.[2];
  const draftId = pathname.match(/^\/drafts\/([0-9a-f-]{36})$/i)?.[1];
  const section = pathname === "/repos" ? "/repos" : "/queue";

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
