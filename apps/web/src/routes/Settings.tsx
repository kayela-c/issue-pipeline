import { linkHandler } from "../lib/router";
import { AiSettings } from "./settings/AiSettings";
import { Connections } from "./settings/Connections";
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
      {current === "/settings/connections" && <Connections />}
      {current === "/settings/templates" && <Templates />}
    </>
  );
}
