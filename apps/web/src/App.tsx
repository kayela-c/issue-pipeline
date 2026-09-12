import { useEffect } from "react";
import { ApiError } from "./lib/api";
import { useMe } from "./lib/auth";
import { Home, NoAccess } from "./routes/Home";
import { Login } from "./routes/Login";
import "./App.css";

export default function App() {
  const me = useMe();
  const error = me.error instanceof ApiError ? me.error : undefined;

  // Signed in but still on /login (e.g. back button): tidy the address bar.
  useEffect(() => {
    if (me.data && window.location.pathname === "/login") {
      window.history.replaceState(null, "", "/");
    }
  }, [me.data]);

  return (
    <main className="container">
      <header>
        <h1>Issue Pipeline</h1>
        <p className="muted">
          Rough notes in, well-formed Gitea issues out — with a human in the
          middle.
        </p>
      </header>

      {me.isPending && <p className="muted spaced">Loading…</p>}
      {error?.code === "unauthorized" && <Login />}
      {error?.code === "forbidden" && <NoAccess message={error.message} />}
      {me.error && error?.code !== "unauthorized" && error?.code !== "forbidden" && (
        <section className="card">
          <p className="status status--bad">
            <strong>Could not load your account.</strong> {me.error.message}
          </p>
          <button type="button" onClick={() => void me.refetch()} disabled={me.isFetching}>
            Try again
          </button>
        </section>
      )}
      {me.data && <Home me={me.data} />}
    </main>
  );
}
