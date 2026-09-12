import { HealthCard } from "./components/HealthCard";
import "./App.css";

export default function App() {
  return (
    <main className="container">
      <header>
        <h1>Issue Pipeline</h1>
        <p className="muted">
          Rough notes in, well-formed Gitea issues out — with a human in the
          middle.
        </p>
      </header>
      <HealthCard />
    </main>
  );
}
