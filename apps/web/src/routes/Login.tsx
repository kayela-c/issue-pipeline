import { useState } from "react";
import { startGithubLogin, startLogin } from "../lib/api";
import { loginErrorMessage } from "../lib/auth";

type Provider = "gitea" | "github" | null;

export function Login() {
  const [redirecting, setRedirecting] = useState<Provider>(null);
  const error = loginErrorMessage(window.location.search);

  // Come back to where the user was, unless that was the login page itself.
  const returnTo = () => {
    const { pathname, search } = window.location;
    return pathname === "/login" ? "/" : pathname + search;
  };

  const signInWithGitea = () => {
    setRedirecting("gitea");
    startLogin(returnTo());
  };

  const signInWithGithub = () => {
    setRedirecting("github");
    startGithubLogin(returnTo());
  };

  return (
    <section className="card">
      <h2>Sign in</h2>
      <p className="muted spaced">
        You will be sent to approve access, then brought back here.
      </p>

      {error && (
        <p className="status status--bad">
          <strong>Could not sign you in.</strong> {error}
        </p>
      )}

      <div className="login-providers">
        <button type="button" onClick={signInWithGitea} disabled={redirecting !== null}>
          {redirecting === "gitea" ? "Opening Gitea…" : "Sign in with Gitea"}
        </button>
        <button type="button" onClick={signInWithGithub} disabled={redirecting !== null}>
          {redirecting === "github" ? "Opening GitHub…" : "Sign in with GitHub"}
        </button>
        <button type="button" disabled title="GitLab sign-in is coming soon.">
          Sign in with GitLab (coming soon)
        </button>
      </div>

      <p className="muted spaced">
        Either one works, and both lead to the same account once linked in Settings &gt; Connections.
      </p>
    </section>
  );
}
