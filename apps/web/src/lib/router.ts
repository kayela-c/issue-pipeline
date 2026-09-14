import { useSyncExternalStore } from "react";

/**
 * A few lines of history-API routing: the app has a handful of screens, which
 * does not justify a router dependency. Netlify serves index.html for every
 * non-API path, so deep links and reloads work.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(path: string) {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

/** Navigate without adding a history entry (for redirects). */
export function replace(path: string) {
  window.history.replaceState(null, "", path);
  for (const listener of listeners) listener();
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** One query-string parameter of the current URL, kept in sync with navigation. */
export function useSearchParam(name: string): string | null {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return new URLSearchParams(search).get(name);
}

/** Set (or clear) one query-string parameter without a history entry, keeping the rest. */
export function setSearchParam(name: string, value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(name, value);
  else params.delete(name);
  const qs = params.toString();
  replace(window.location.pathname + (qs ? `?${qs}` : ""));
}

/** Left-click handler for in-app links that keeps modifier-clicks working. */
export function linkHandler(path: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };
}
