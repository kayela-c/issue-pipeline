import type { MeResponse } from "@issue-pipeline/shared";
import { HealthCard } from "../components/HealthCard";
import { useLogout } from "../lib/auth";

export function Home({ me }: { me: MeResponse }) {
  const logout = useLogout();

  return (
    <>
      <section className="card">
        <h2>Account</h2>
        <p className="status status--good">
          Signed in as <strong>{me.username}</strong>
          {me.display_name ? ` (${me.display_name})` : ""}
        </p>
        <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </section>
      <HealthCard />
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
