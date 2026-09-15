import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, getMe, logout } from "./api";

export const ME_KEY = ["me"] as const;

/**
 * The signed-in user, and the source of truth for "am I signed in?".
 * A 401 means signed out; a 403 means signed in but not in the org.
 */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: getMe,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    staleTime: 60_000,
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: logout,
    // A full reload drops every cached query that belonged to the old user.
    onSettled: () => window.location.assign("/login"),
  });
}

const LOGIN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled in Gitea.",
  not_member: "Your Gitea account is not a member of the organization this app is limited to.",
  expired: "That sign-in attempt expired. Try again.",
  failed: "Gitea did not accept the sign-in. Try again, and tell an admin if it keeps happening.",
  unavailable: "Gitea could not be reached. Try again shortly.",
  gitea_already_linked: "That Gitea account is already linked to a different sign-in.",
  github_denied: "Sign-in was cancelled in GitHub.",
  github_expired: "That sign-in attempt expired. Try again.",
  github_failed: "GitHub did not accept the sign-in. Try again, and tell an admin if it keeps happening.",
  github_unavailable: "GitHub could not be reached. Try again shortly.",
  github_not_allowed: "That GitHub account is not allowed to sign in here.",
  github_link_expired: "Your linked Gitea session has expired. Sign in with Gitea, then reconnect GitHub in Settings.",
  github_already_linked: "That GitHub account is already linked to a different sign-in.",
};

/** The explanation for a `/login?error=` redirect from the API, if any. */
export function loginErrorMessage(search: string): string | undefined {
  const code = new URLSearchParams(search).get("error");
  return code ? (LOGIN_ERRORS[code] ?? "Sign-in failed. Try again.") : undefined;
}
