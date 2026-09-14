import { linkHandler } from "../lib/router";
import { AiSettings } from "./settings/AiSettings";
import { Templates } from "./settings/Templates";

const TABS = [
  { path: "/settings/ai", label: "AI model" },
  { path: "/settings/connections", label: "Connections" },
  { path: "/settings/templates", label: "Templates" },
];

/** Settings, with one sub-page per tab: /settings/ai, /settings/connections, /settings/templates. */
export function Settings({ pathname }: { pathname: string }) {
  const current = TABS.find((t) => pathname === t.path)?.path ?? "/settings/ai";

  return (
    <>
      <nav className="subnav" aria-label="Settings">
        {TABS.map((tab) => (
          <a
            key={tab.path}
            href={tab.path}
            onClick={linkHandler(tab.path)}
            aria-current={current === tab.path ? "page" : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      {current === "/settings/ai" && <AiSettings />}
      {current === "/settings/connections" && (
        <section className="card">
          <h2>Connections</h2>
          <p className="muted">
            Connecting GitHub, GitLab, and Bitbucket arrives in a later phase. You are signed in with Gitea, which is used for
            every tracked repository today.
          </p>
        </section>
      )}
      {current === "/settings/templates" && <Templates />}
    </>
  );
}
