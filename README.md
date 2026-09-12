# Issue Pipeline

Turns rough issue notes into well-formed Gitea issues, with a human approval gate
in the middle.

- **Stage 1 (AI):** raw notes + a repo read produce issue drafts that follow the
  repo's issue template, including dependencies between them.
- **Stage 2 (no AI):** a teammate approves; deterministic code posts each draft
  to Gitea under the posting user's own account, in dependency order.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
apps/desktop      Tauri 2 + React client (the only thing teammates install)
apps/api          Netlify Functions -- Neon Postgres, Gitea, Anthropic
packages/shared   zod schemas + types: the API contract, built to dist/
scripts           Python utilities (seeding, smoke tests)
netlify.toml      site config; lives at the root, see "Gotchas"
```

## Prerequisites

- Node 20+ and pnpm 10
- Rust stable, **plus the MSVC toolchain on Windows** — Visual Studio's
  "Desktop development with C++" workload. Without it `cargo` cannot link and
  the desktop app will not build.
- A `.env` at the repository root; copy `.env.example` and fill it in.

## Running it

```sh
pnpm install

# API on http://localhost:8888 (also compiles packages/shared first)
pnpm dev:api
curl http://localhost:8888/api/health     # -> {"db":"ok","now":...,"version":"dev"}

# Desktop app (needs the MSVC toolchain)
pnpm dev:desktop
```

Useful checks:

```sh
pnpm -r typecheck
pnpm -r test
pnpm db:generate        # generate a migration from src/db/schema.ts
pnpm db:migrate         # apply migrations to $DATABASE_URL
```

## Gotchas

- **`netlify.toml` is at the repository root, not in `apps/api`.** The Netlify
  CLI resolves `publish` and `functions` from the repository root even when
  `--filter` names a workspace package, so the paths are written root-relative.
  Deploy the site with no base directory configured.
- **`.env` is at the repository root too**, because that is where the CLI runs.
- **`packages/shared` is consumed as built JavaScript** (`dist/`), not as
  TypeScript source. Netlify's bundler leaves `node_modules` packages external,
  and Node's TypeScript support will not resolve extensionless or `.js`
  specifiers to `.ts` files. `pnpm dev:api` rebuilds it; use
  `pnpm --filter @issue-pipeline/shared dev` to watch it while editing.

## Security

Tokens live in the OS keychain and are handled only by Rust; the React layer
never sees one. No database credentials or AI keys ship in the installer — the
desktop app talks only to the API, which holds them. See section 10 of the
architecture doc for the full checklist.
