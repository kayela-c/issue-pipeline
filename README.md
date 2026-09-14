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

Opt-in live tests (skipped by default):

```sh
LIVE_DB=1  pnpm --filter @issue-pipeline/api exec vitest run src/db    # Neon dev branch
LIVE_LLM=1 pnpm --filter @issue-pipeline/api exec vitest run src/llm   # configured LLM provider
```

### Choosing the AI provider

Each user can pick a provider, models, and their own API key under
**Settings > AI model**. Saved keys are encrypted with `CREDENTIALS_KEY` and
never shown again. Users who keep "Team default" use `LLM_PROVIDER` from
`.env`; each provider keeps its own settings, so switching the team default is
one line plus a restart of `pnpm dev`. A provider's env key and models are
also the fallback for users who pick it without adding their own key.

| `LLM_PROVIDER` | Needs | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Structured outputs + prompt caching |
| `gemini` | `GOOGLE_API_KEY` (Google AI Studio, with credits) | Called over REST with a JSON schema |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL_*` | OpenAI-compatible chat completions with a JSON schema |
| `grok` | `XAI_API_KEY`, `XAI_MODEL_*` | Same client as OpenAI |
| `venice` | `VENICE_API_KEY`, `VENICE_MODEL_*` | Same client; pick a model that supports response schemas |
| `lmstudio` | LM Studio 0.4.1+ running locally, `LMSTUDIO_MODEL_*`, `LMSTUDIO_CONTEXT_TOKENS` | Local development only, not offered in Settings; prompts are sized to the loaded context length |

Each run records `provider/model` and the run page shows it.

### Repository conventions: README.md and ROUTING.md

Drafting reads two files from the root of each tracked repository:

- **`README.md`**: the overview of the project.
- **`ROUTING.md`**: a map of where each area of the system lives, for
  example `- Password reset: app/Http/Controllers/Auth/, routes/web.php`.
  The model uses it to choose which files to read and to fill fields such as
  "Files / components affected". When the file list must be shortened for a
  small model, paths it names are kept first. Repos without one still work.

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
- **Netlify's secrets scanner flags non-secret env vars** whose values
  collide with ordinary words used throughout the code and docs (an org
  name, a public Gitea host, etc.). Those are listed in
  `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml`; real secrets are not exempted
  and stay scanned.

## Deployment

One Netlify site builds `main` and serves both the SPA and the API — see
[section 9 of the architecture doc](docs/ARCHITECTURE.md) for environment
variables, the Gitea OAuth redirect URIs, and provider constraints
(`lmstudio` only runs under `netlify dev`; set `CREDENTIALS_KEY` so users can
save API keys in Settings). After a deploy, verify the happy path end-to-end:

```sh
pip install -r scripts/requirements.txt
python scripts/smoke_test.py --base-url https://<site>.netlify.app \
    --token <gitea-personal-access-token> --owner <org> --repo <repo>
```

The token needs the same scopes the app itself requests: `read:user
read:organization read:repository write:issue`.

## Security

The browser never holds a Gitea token. Sign-in is a server-side OAuth flow, and
the session lives in an AES-256-GCM encrypted `HttpOnly` cookie that the API
decrypts per request. State-changing requests must come from this site's own
origin. No database credentials or API keys reach the browser. See section 10 of
the architecture doc for the full checklist.
