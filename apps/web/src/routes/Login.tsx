import { useState } from "react";
import { startLogin } from "../lib/api";
import { loginErrorMessage } from "../lib/auth";

export function Login() {
  const [redirecting, setRedirecting] = useState(false);
  const error = loginErrorMessage(window.location.search);

  const signIn = () => {
    setRedirecting(true);
    // Come back to where the user was, unless that was the login page itself.
    const { pathname, search } = window.location;
    startLogin(pathname === "/login" ? "/" : pathname + search);
  };

  return (
    <section className="card">
      <h2>Sign in</h2>
      <p className="muted spaced">
        Use your Gitea account. You will be sent to Gitea to approve access, then
        brought back here.
      </p>

      {error && (
        <p className="status status--bad">
          <strong>Could not sign you in.</strong> {error}
        </p>
      )}

      <button type="button" onClick={signIn} disabled={redirecting}>
        {redirecting ? "Opening Gitea…" : "Sign in with Gitea"}
      </button>
    </section>
  );
}
