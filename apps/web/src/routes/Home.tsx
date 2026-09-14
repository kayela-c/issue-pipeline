import type { MeResponse } from "@issue-pipeline/shared";
import { useLogout } from "../lib/auth";
import { useEffect } from "react";
import { linkHandler, replace, usePathname } from "../lib/router";
import { Board } from "./Board";
import { DraftEditor } from "./DraftEditor";
import { NewIssue } from "./NewIssue";
import { Queue } from "./Queue";
import { Repos } from "./Repos";

const NAV = [
  { path: "/", label: "New issue" },
  { path: "/queue", label: "Queue" },
  { path: "/board", label: "Board" },
  { path: "/repos", label: "Repositories" },
];

export function Home({ me }: { me: MeResponse }) {
  const logout = useLogout();
  const pathname = usePathname();
  // /queue and /queue/<run id>; older /runs/<run id> links land here too.
  const queueMatch = pathname.match(/^\/(queue|runs)(?:\/([0-9a-f-]{36}))?$/i);
  const selectedRunId = queueMatch?.[2];
  const draftId = pathname.match(/^\/drafts\/([0-9a-f-]{36})$/i)?.[1];
  const section = queueMatch ? "/queue" : draftId ? "/board" : pathname;

  useEffect(() => {
    if (pathname.startsWith("/runs")) replace(selectedRunId ? `/queue/${selectedRunId}` : "/queue");
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
        <span className="nav-user muted small">
          {me.display_name || me.username}
          <button type="button" className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </button>
        </span>
      </nav>

      {queueMatch ? (
        <Queue selectedId={selectedRunId} />
      ) : draftId ? (
        <DraftEditor key={draftId} draftId={draftId} />
      ) : pathname === "/board" ? (
        <Board />
      ) : pathname === "/repos" ? (
        <Repos />
      ) : (
        <NewIssue />
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
