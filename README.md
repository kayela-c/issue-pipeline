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
apps/web          React SPA (Vite), served by the same Netlify site as the API
apps/api          Netlify Functions -- auth, Neon Postgres, Gitea, Anthropic
packages/shared   zod schemas + types: the API contract, built to dist/
scripts           Python utilities (seeding, smoke tests)
netlify.toml      site config; lives at the root, see "Gotchas"
```

## Prerequisites

- Node 20+ and pnpm 10
- A `.env` at the repository root; copy `.env.example` and fill it in.
- A Gitea OAuth2 application registered as a **confidential** client with the
  redirect URI `http://localhost:8888/api/auth/callback`.

## Running it

```sh
pnpm install
pnpm dev          # SPA + API on http://localhost:8888 (builds packages/shared first)
```

Open **http://localhost:8888** — not Vite's own port 5173. Only 8888 serves the
functions, and it is the origin registered for the OAuth redirect.

Useful checks:

```sh
pnpm -r typecheck
pnpm -r test
pnpm db:generate        # generate a migration from src/db/schema.ts
pnpm db:migrate         # apply migrations to $DATABASE_URL
curl http://localhost:8888/api/health
```

Scripts and tests can call the API without a browser by sending a Gitea
personal access token as `Authorization: Bearer <token>`.

## Gotchas

- **`netlify.toml` is at the repository root, not in `apps/api`.** The Netlify
  CLI resolves `publish` and `functions` from the repository root even when
  `--filter` names a workspace package, so the paths are written root-relative.
  Deploy the site with no base directory configured.
- **`.env` is at the repository root too**, because that is where the CLI runs.
- **`packages/shared` is consumed as built JavaScript** (`dist/`), not as
  TypeScript source. Netlify's bundler leaves `node_modules` packages external,
  and Node's TypeScript support will not resolve extensionless or `.js`
  specifiers to `.ts` files. `pnpm dev` rebuilds it; use
  `pnpm --filter @issue-pipeline/shared dev` to watch it while editing.
- **A stale `netlify dev` keeps port 8888.** A new one then fails with "Could
  not acquire required 'port'" while requests silently hit the old server. Stop
  the old process first.
- **One function per auth route.** For cross-origin requests `netlify dev`
  retries the path with `/index.html` appended, so a function that routes on
  `pathname` misroutes them. Keep routing in `config.path`.
- **The Content Security Policy for scripts is added at build time only**
  (`apps/web/vite.config.ts`); Vite's dev server needs inline scripts.

## Security

The browser never holds a Gitea token. Sign-in is a server-side OAuth flow, and
the session lives in an AES-256-GCM encrypted `HttpOnly` cookie that the API
decrypts per request. State-changing requests must come from this site's own
origin. No database credentials or API keys reach the browser. See section 10 of
the architecture doc for the full checklist.
