# Issue Pipeline -- Architecture Plan

> Handoff document for Claude Code. Working name: `issue-pipeline`.
>
> Revision history:
> - 2026-09-12: the client became a **web app** (React SPA on the Netlify site), replacing the original Tauri desktop app.
> - 2026-09-13: AI provider selectable by env var (Anthropic, Gemini, LM Studio for local dev); `ROUTING.md` convention; workflow Queue; Phase 3 review UI. Status of every phase is in Section 12.

## 0. Instructions for Claude Code

1. Build **one phase at a time** (Section 12). Stop at the end of each phase, summarize what was built, and list anything that deviated from this plan.
2. Items marked **VERIFY** must be checked against the real Gitea instance, Netlify plan, or current docs before the code depends on them. If a VERIFY item turns out false, stop and report instead of improvising a workaround.
3. Do not add dependencies beyond those listed without flagging them first. No LangChain or agent frameworks: AI calls go through the small clients in `apps/api/src/llm` (the `@anthropic-ai/sdk` for Anthropic and LM Studio, plain REST for Gemini).
4. Standalone utility scripts (seeding, smoke tests, maintenance) are written in **Python**. Application code is TypeScript (API and UI).
5. A token or API key must never be logged, placed in a URL, or made readable by browser JavaScript. The sign-in Gitea token exists at rest only inside the encrypted, `HttpOnly` session cookie (Section 5). Credentials a user adds in Settings (AI provider keys; the linked Gitea refresh token snapshot from Phase 8's GitHub sign-in; and from Phase 9, forge connection tokens) are stored in Postgres **only as AES-256-GCM ciphertext** under `CREDENTIALS_KEY`, decrypted only inside the function that uses them, and never returned by the API (responses carry at most `has_key`/linked-username and the last 4 characters). Changed 2026-09-14, decision 21.
6. Keep this file ASCII-only.

---

## 1. Purpose

A web app for a small team that turns rough issue notes into well-formed Gitea issues.

**Stage 1 -- Drafting (AI).** A user submits raw issue text against a repo. The system reads the repo through the Gitea API (guided by the repo's `README.md` and `ROUTING.md`), and an AI produces one or more issue drafts that follow the repo's Gitea issue template, including dependencies between the drafts. Drafts land in the database for human review.

**Stage 2 -- Posting (no AI).** A teammate approves drafts. An approved draft whose dependencies are all posted is claimed atomically, created in Gitea under the posting user's account, linked to its dependencies, and marked `posted` with its issue number. This stage is deterministic code only.

**Non-goals for v1:** native desktop app, offline mode, syncing edits back from Gitea after posting, auto-posting without approval, Excel import/export, cross-repo dependencies, sign-in on Netlify deploy previews, signing in with anything other than Gitea.

(GitHub/GitLab/Bitbucket support and choosing the AI provider from the UI were non-goals until 2026-09-14; they are now Phases 6-10, decision 21.)

---

## 2. Architecture overview

```
Browser (React SPA, served from the same Netlify site as the API)
  |  fetch('/api/...') same-origin. No token in JavaScript: the session is an
  |  encrypted HttpOnly cookie.
  |
  +-- GET /api/auth/login ------302----> Gitea /login/oauth/authorize  (PKCE)
  |                                          |
  +-- GET /api/auth/callback <---302---------+  code exchanged server-side,
  |                                             session cookie set
  |
  +-- /api/* (session cookie) --> Netlify Functions (TypeScript)
                                    +-- Neon Postgres    state + queue
                                    +-- Gitea REST API   read repo, post issues (as the user)
                                    +-- AI provider      Stage 1 drafting only
                                         (per-user choice in Settings, else LLM_PROVIDER:
                                          anthropic | gemini | openai | grok | venice | lmstudio)
```

| Decision | Choice | Why |
|---|---|---|
| Client | React SPA (Vite) on the same Netlify site as the functions | One deploy, same origin (no CORS), no installers or updater |
| Source of truth | Neon Postgres | Shared team queue; Gitea is the system of record once posted |
| API layer | Netlify Functions v2 (TS) | Secrets stay server-side |
| Session | Stateless encrypted cookie (AES-256-GCM), `HttpOnly` | Tokens never reach JavaScript and are never stored in Postgres; no session table |
| Long work | Netlify Background Functions | Sync functions cap at 60 s by default; background functions allow 15 min |
| Orchestration | Plain code, no n8n | Two linear stages; one repo; versioned with the app |
| Identity | Gitea OAuth2, **confidential** client + PKCE | No separate user system; issues are authored by the real user |
| Access control | Membership in one Gitea org | Simple team gate |
| AI usage | Two narrow calls in Stage 1 only; provider chosen per user in Settings, team default by env var | Posting stays predictable and cheap; people can bring their own provider and key without code changes |
| Repo context | `ROUTING.md` + `README.md` at each repo root, plus the file tree | The routing map tells the model where each area of the system lives |
| Forge access | `ForgeClient` interface, Gitea implementation | Keeps GitHub possible later without a rewrite |
| Realtime | Polling (run detail 2 s while active; queue 3 s while anything runs, else 15 s; board 10 s, 2 s while posting) | Functions are stateless; no websockets needed |

---

## 3. Repository layout

pnpm workspaces monorepo. One Netlify site: `publish` is the SPA build, `functions` is the API.

```
issue-pipeline/
+-- apps/
|   +-- web/                          # Vite + React + TypeScript SPA
|   |   +-- src/
|   |   |   +-- main.tsx              # TanStack Query client (retry policy, 401 handling)
|   |   |   +-- App.tsx               # signed-in vs sign-in vs no-access
|   |   |   +-- lib/api.ts            # typed fetch wrapper (same-origin, JSON, zod-parsed)
|   |   |   +-- lib/auth.ts           # session hooks (useMe, logout, login error messages)
|   |   |   +-- lib/router.ts         # tiny history-API router (no router dependency)
|   |   |   +-- routes/               # Login, Home (nav), NewIssue, Queue, RunView, Board, DraftEditor, Repos, Settings
|   |   |   +-- routes/settings/      # AiSettings, Templates, Connections
|   |   |   +-- components/Markdown.tsx  # react-markdown, raw HTML never rendered
|   |   +-- public/api-not-found.json # JSON 404 for unknown /api paths
|   |   +-- vite.config.ts            # build-time CSP meta tag
|   +-- api/
|       +-- netlify/functions/        # one file per route group (see Section 5) + draft-run-background
|       +-- src/
|       |   +-- http.ts               # json/apiError/HttpError, readJson, requireUuid
|       |   +-- jobs.ts               # background-job trigger + INTERNAL_JOB_SECRET check
|       |   +-- db/schema.ts          # Drizzle schema (matches Section 4)
|       |   +-- db/client.ts          # neon-http + drizzle
|       |   +-- db/users.ts, repos.ts, runs.ts, drafts.ts  # queries and guarded writes
|       |   +-- auth/session.ts       # cookie encrypt/decrypt, cookie attributes
|       |   +-- auth/oauth.ts         # authorize URL, code exchange, refresh (Gitea)
|       |   +-- auth/csrf.ts          # Origin / Sec-Fetch-Site / JSON content-type check
|       |   +-- auth/handlers.ts      # login, callback, logout
|       |   +-- auth/withAuth.ts      # session-or-bearer wrapper, refresh, org gate
|       |   +-- forge/types.ts        # ForgeClient interface
|       |   +-- forge/gitea.ts        # Gitea implementation (retries, typed ForgeError)
|       |   +-- forge/fake.ts         # test double
|       |   +-- llm/types.ts          # LlmClient, limits, usage, LlmOutputError
|       |   +-- llm/index.ts          # provider resolution (user settings -> team env), error description/classification
|       |   +-- llm/anthropic.ts      # Anthropic SDK client (Anthropic API, or LM Studio's endpoint)
|       |   +-- llm/gemini.ts         # Gemini REST client
|       |   +-- llm/openai.ts         # OpenAI-compatible REST client (OpenAI, xAI Grok, Venice)
|       |   +-- llm/models.ts         # live model lists for the Settings pickers
|       |   +-- crypto/aead.ts        # AES-256-GCM core shared by session cookies and stored credentials
|       |   +-- crypto/credentials.ts # CREDENTIALS_KEY sealing, AAD bound to column + user + subject
|       |   +-- settings/ai.ts        # per-user AI settings DTO and llmConfigForUser
|       |   +-- db/settings.ts        # user_ai_settings / user_ai_providers queries
|       |   +-- settings/templates.ts # template request parsing, usability check, repoForge
|       |   +-- db/templates.ts       # issue_templates queries, run snapshots
|       |   +-- pipeline/draft.ts     # Stage 1 job
|       |   +-- pipeline/tree.ts      # tree filtering, README/ROUTING.md discovery
|       |   +-- pipeline/templates.ts # issue template discovery + parsing
|       |   +-- pipeline/budget.ts    # prompt sizing for small-context models
|       |   +-- pipeline/validate.ts  # AI output validation, dropdown snapping, sanitizing
|       |   +-- pipeline/graph.ts     # cycle detection
|       |   +-- pipeline/review.ts    # review rules: dependency checks, refusal reasons
|       |   +-- pipeline/post.ts      # Stage 2: postDraft, reconcileDraft
|       +-- prompts/                  # versioned prompts as TS string modules
|       +-- drizzle/                  # generated migrations (0000_init, 0001_snapshot_routing)
|       +-- drizzle.config.ts
+-- packages/
|   +-- shared/                       # zod schemas + inferred TS types (API contract)
+-- scripts/                          # Python utilities (smoke_test.py; seed_gitea.py -- not yet built)
+-- docs/ARCHITECTURE.md              # this file
+-- feature-task.yml                  # the TrueRoster issue form, used as a test fixture
+-- netlify.toml                      # at the repo root (see README "Gotchas")
+-- pnpm-workspace.yaml
```

**Local dev:** `pnpm dev` runs `netlify dev`, which fronts the Vite dev server and serves functions on the same origin, `http://localhost:8888`. Cookies, OAuth redirects, and the CSRF origin check therefore behave as in production. Start it from your own terminal: on a machine short of memory, background copies get killed.

**SPA routing:** `netlify.toml` adds a `/* -> /index.html 200` fallback, preceded by a forced `/api/* -> /api-not-found.json 404` rule so unknown API paths return JSON rather than the SPA shell. Functions with a `config.path` take precedence over both rules (confirmed under `netlify dev`; re-check on the first production deploy).

---

## 4. Data model (Neon Postgres)

Defined in Drizzle (`apps/api/src/db/schema.ts`); migrations are generated with `drizzle-kit` and applied with `pnpm db:migrate`. Applied so far: `0000_init`, `0001_snapshot_routing` (adds `repo_snapshots.routing` and clears cached snapshots), `0002_user_ai_settings` (Phase 6; applied to both the Neon `dev` and `main` branches, 2026-09-14), `0003_issue_templates` (Phase 7; applied to both the Neon `dev` and `main` branches, 2026-09-14), `0004_user_identities` and `0005_nullable_gitea` (Phase 8; both applied to the Neon `dev` branch 2026-09-14; `0005` drops the `NOT NULL` on `users.gitea_id` and `user_identities.gitea_refresh_token_enc` for GitHub-created accounts, decision 22), `0006_github_repos` (Phase 9; applied to the Neon `dev` branch 2026-09-15; adds `repos.forge`, widens the repo unique key to `(forge, owner, name)`, and adds `user_identities.access_token_enc`). None of `0004`-`0006` is on the Neon `main` branch yet. Statuses use `text` + `CHECK` rather than enums so they are easy to extend.

There is deliberately **no sessions table**: session state lives in the encrypted cookie (Section 5).

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null for an account created directly by a non-Gitea sign-in (decision 22)
  -- that has not connected Gitea yet. Postgres UNIQUE allows any number of
  -- NULLs, so this stays a plain unique constraint.
  gitea_id      bigint UNIQUE,
  username      text NOT NULL,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Phase 8: one account, any number of linked forge identities (decision 22).
-- Gitea sign-in still creates the account by default (users.gitea_id); GitHub
-- sign-in can now create one directly too, with gitea_id left null.
CREATE TABLE user_identities (
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  forge                    text NOT NULL CHECK (forge IN ('github','gitlab','bitbucket')),
  forge_user_id            text NOT NULL,
  username                 text NOT NULL,
  -- Snapshot of the account's Gitea refresh token, AES-256-GCM ciphertext
  -- under CREDENTIALS_KEY, AAD
  -- "user_identities.gitea_refresh_token:<user_id>:<forge>". A sign-in
  -- through this identity refreshes it (Gitea rotates on every use), since
  -- every tracked repo lives on Gitea today and this is what mints a working
  -- Gitea session with no Gitea prompt (Section 5). Null when the account has
  -- no Gitea link at all yet -- signing in through this identity then signs
  -- straight in, Gitea-less, rather than minting anything.
  gitea_refresh_token_enc  text,
  -- Phase 9: this forge's own access token, for reading and posting to repos
  -- hosted there. AES-256-GCM under CREDENTIALS_KEY, AAD
  -- "user_identities.access_token:<user_id>:<forge>". Refreshed on every
  -- sign-in or link through this identity; null when the grant lacked repo
  -- access (GitHub: the `repo` scope). GitHub OAuth App tokens do not expire.
  access_token_enc         text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, forge),
  UNIQUE (forge, forge_user_id)
);

CREATE TABLE repos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forge           text NOT NULL DEFAULT 'gitea' CHECK (forge IN ('gitea','github')),  -- Phase 9
  owner           text NOT NULL,
  name            text NOT NULL,
  default_branch  text NOT NULL,
  added_by        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (forge, owner, name)
);

-- Cached repo read, keyed by commit so an unchanged repo is never re-read.
CREATE TABLE repo_snapshots (
  repo_id     uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha  text NOT NULL,
  tree        jsonb NOT NULL,                 -- [{path, size}] after filtering
  readme      text,
  routing     text,                           -- ROUTING.md at root, null when absent
  templates   jsonb NOT NULL DEFAULT '[]',    -- issue templates at this commit
  labels      jsonb NOT NULL DEFAULT '[]',    -- [{id, name}]
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE raw_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id     uuid NOT NULL REFERENCES repos(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_issue_id    uuid NOT NULL REFERENCES raw_issues(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','reading_repo','selecting_files',
                                    'drafting','done','failed')),
  commit_sha      text,
  prompt_version  text,
  model_select    text,                       -- "provider/model"
  model_draft     text,                       -- "provider/model"
  input_tokens    int,
  output_tokens   int,
  error           text,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

CREATE TABLE drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid REFERENCES runs(id) ON DELETE SET NULL,
  repo_id        uuid NOT NULL REFERENCES repos(id),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  body           text NOT NULL,
  template_name  text,
  labels         text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','approved','posting','posted','failed')),
  version        int NOT NULL DEFAULT 1,      -- optimistic concurrency for edits
  created_by     uuid NOT NULL REFERENCES users(id),
  approved_by    uuid REFERENCES users(id),
  claimed_by     uuid REFERENCES users(id),
  claimed_at     timestamptz,
  gitea_number   int,
  gitea_url      text,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'posted' OR gitea_number IS NOT NULL)
);
CREATE INDEX drafts_repo_status_idx ON drafts (repo_id, status);

-- Phase 7: team-wide issue templates managed in Settings.
CREATE TABLE issue_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  forges      text[] NOT NULL CHECK (cardinality(forges) > 0
                AND forges <@ ARRAY['gitea','github','gitlab','bitbucket']),
  kind        text NOT NULL CHECK (kind IN ('markdown','form')),
  content     text NOT NULL CHECK (length(content) BETWEEN 1 AND 50000),
  version     int NOT NULL DEFAULT 1,            -- optimistic concurrency for edits
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE raw_issues ADD COLUMN template_id uuid REFERENCES issue_templates(id) ON DELETE SET NULL;
-- {id, name, file, kind, content, version}: the app template copied at submission,
-- so editing or deleting it never changes the run or its retries. NULL = repo templates.
ALTER TABLE runs ADD COLUMN template_snapshot jsonb;

-- Phase 6: per-user AI settings. No row, or provider NULL, means the team default.
CREATE TABLE user_ai_settings (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider    text CHECK (provider IS NULL OR provider IN ('anthropic','gemini','grok','openai','venice')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per provider a user has configured. api_key_enc is AES-256-GCM
-- ciphertext under CREDENTIALS_KEY, AAD "user_ai_providers.api_key:<user_id>:<provider>".
CREATE TABLE user_ai_providers (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('anthropic','gemini','grok','openai','venice')),
  model_select   text,                       -- NULL = team/built-in default
  model_draft    text,
  api_key_enc    text,                       -- NULL = use the team key for this provider
  api_key_last4  text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE draft_deps (
  draft_id         uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  depends_on_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  linked_in_gitea  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (draft_id, depends_on_id),
  CHECK (draft_id <> depends_on_id)
);

CREATE TABLE draft_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id),
  event       text NOT NULL,  -- created|edited|deps_changed|approved|unapproved|
                              -- claimed|posted|failed|reconciled|link_failed
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### Draft state machine

```
draft --approve--> approved --claim--> posting --success--> posted
  ^                  |  ^                 |
  +---unapprove------+  +--retry-- failed <+ (error before issue was created)
                           ^
               posting (stale > 5 min) --reconcile--> posted | approved
```

Rules enforced in the API, not just the UI:

- Title, body, labels, and deps can be edited only while `status = 'draft'`. Every edit requires the client's `version`; a mismatch returns **409** and a successful edit increments `version`.
- Approve requires the `version` the approver reviewed. Approve, unapprove, and dependency changes also increment `version`, so an editor holding an older version gets 409.
- A draft's dependencies can be changed only while that draft is in `draft` status. Targets must be drafts in the same repo (any status; an already-posted target simply counts as satisfied), and the change must not create a cycle (DFS in `pipeline/graph.ts`, message names the cycle).
- Only `draft` drafts can be deleted. Their dependency edges and events cascade.
- Anyone in the org may approve, including the draft's author.

**How the rules hold under concurrency.** The Neon HTTP driver has no interactive transactions, so every change is a single guarded statement (`UPDATE ... WHERE status = ... AND version = ... RETURNING`), and its `draft_events` row is inserted from that statement's `RETURNING` in a data-modifying CTE. A refused change therefore writes nothing; the API re-reads the draft and answers 404, or 409 with `details.reason` of `status` (wrong state) or `stale` (someone else saved first). A dependency change runs as a transaction that ends with a recursive reachability query dividing by zero when the draft can reach itself, so two concurrent changes that together form a cycle are rolled back even though each passed the application check.

### Atomic claim (the only way a draft enters `posting`)

```sql
UPDATE drafts d
SET status = 'posting', claimed_by = $1, claimed_at = now(), updated_at = now()
WHERE d.id = $2
  AND d.status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM draft_deps dd
    JOIN drafts p ON p.id = dd.depends_on_id
    WHERE dd.draft_id = d.id AND p.status <> 'posted')
RETURNING *;
```

Zero rows means the draft is not approved, has unposted dependencies, or was claimed by someone else. The API reports which by re-reading the row.

---

## 5. API (Netlify Functions, TypeScript)

**Stack:** Netlify Functions v2 (`export default async (req, context)` with `export const config = { path, method }`), Drizzle ORM over `@neondatabase/serverless` (HTTP driver), `zod` for every request and AI output, `@anthropic-ai/sdk`, and `yaml` for issue templates. Gemini is called over plain REST. Session encryption uses `node:crypto`. No web framework. Multi-statement atomic writes use `db.batch([...])` or the Neon client's `transaction([...])`; conditional writes use guarded CTEs (Sections 4 and 6).

### Environment variables (Netlify)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `LLM_PROVIDER` | The **team default**: `anthropic` (default when unset), `gemini`, `openai`, `grok`, `venice`, or `lmstudio` (local development only; refuses to run when deployed). Users who pick a provider in Settings use theirs instead (Section 6). Switching is one line plus a restart or redeploy |
| `CREDENTIALS_KEY`, `CREDENTIALS_KEY_PREVIOUS` | 32 random bytes, base64. Encrypts API keys saved in Settings; the previous key is accepted for decryption during rotation. Needed only once someone saves a key |
| `OPENAI_API_KEY`, `OPENAI_MODEL_SELECT`, `OPENAI_MODEL_DRAFT` | OpenAI team key and models (no built-in model ids) |
| `XAI_API_KEY`, `XAI_MODEL_SELECT`, `XAI_MODEL_DRAFT` | xAI (Grok) team key and models (no built-in model ids) |
| `VENICE_API_KEY`, `VENICE_MODEL_SELECT`, `VENICE_MODEL_DRAFT` | Venice team key and models (no built-in model ids) |
| `GOOGLE_API_KEY`, `GEMINI_MODEL_SELECT`, `GEMINI_MODEL_DRAFT` | Gemini API key (Google AI Studio, with credits) and models; default `gemini-3.5-flash-lite` / `gemini-3.8-flash` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_SELECT`, `ANTHROPIC_MODEL_DRAFT` | Anthropic API key and models; default `claude-haiku-4-5-20251001` / `claude-sonnet-5` |
| `LMSTUDIO_BASE_URL`, `LMSTUDIO_API_KEY`, `LMSTUDIO_MODEL_SELECT`, `LMSTUDIO_MODEL_DRAFT`, `LMSTUDIO_CONTEXT_TOKENS`, `LMSTUDIO_MAX_OUTPUT_TOKENS` | LM Studio 0.4.1+ (default `http://localhost:1234`). Model ids are required; the context length is the one the model is loaded with, and prompts are sized to fit it |
| `LLM_MAX_OUTPUT_TOKENS` | Optional drafting output cap for any provider |
| `GITEA_BASE_URL` | e.g. `https://git.konceptkit.com` |
| `GITEA_ALLOWED_ORG` | Org short name; only its members may use the app |
| `GITEA_OAUTH_CLIENT_ID` | Gitea OAuth2 application (confidential) |
| `GITEA_OAUTH_CLIENT_SECRET` | Its client secret. Server-side only |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | GitHub OAuth App for sign-in (Phase 8, decision 22) and repository access (Phase 9, decision 23); requests `read:user repo` |
| `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames allowed to sign in or link (case-insensitive). Empty or unset means nobody -- the button is shown but every attempt fails |
| `SESSION_SECRET` | 32 random bytes, base64. Encrypts session and login-state cookies |
| `SESSION_SECRET_PREVIOUS` | Optional. Old key accepted for decryption during rotation |
| `SESSION_MAX_AGE_DAYS` | Absolute session lifetime, default `7` |
| `INTERNAL_JOB_SECRET` | Shared secret for background-function calls |
| `MAX_RUNS_PER_USER_PER_DAY` | Cost guard, default `50` |

Nothing is exposed to the SPA bundle: the web app needs no build-time configuration, because everything it talks to is same-origin.

### Sessions

Two cookies, both encrypted with AES-256-GCM under `SESSION_SECRET` (the previous key is also tried on decrypt). Each value carries a format prefix and uses the cookie name as additional authenticated data, so one cookie can never be replayed as the other.

| Cookie | Contents | Attributes |
|---|---|---|
| `__Host-ip_session` | `{ uid, gitea_id, username, access_token, refresh_token, access_expires_at, session_started_at }` | `HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age` = time left of `SESSION_MAX_AGE_DAYS` |
| `__Host-ip_oauth` | `{ state, code_verifier, return_to, created_at }` | `HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age=600`; deleted at callback |
| `__Host-ip_github_oauth` | `{ state, return_to, created_at }` (no PKCE verifier -- GitHub's OAuth App exchange is a confidential-client `client_secret` request, server-side only) | Same attributes and lifetime as `__Host-ip_oauth`; deleted at the GitHub callback |

- `SameSite=Lax` is required: the OAuth callback is a top-level navigation arriving from Gitea, and it must carry the login-state cookie.
- Browsers accept `Secure` cookies on `http://localhost`, so the `__Host-` names work under `netlify dev`.
- The session cookie must stay under 4 KB; a unit test asserts this with realistic token sizes.
- **Revocation:** logging out deletes the cookie. A copied cookie stays usable until `SESSION_MAX_AGE_DAYS` elapses, **or** until the user (or a Gitea admin) revokes the app's grant in Gitea. Gitea validates OAuth access tokens against the grant, so revocation takes effect on the next request.

### Auth endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/auth/login?return_to=` | Generate `state` and PKCE `code_verifier` / S256 `code_challenge`; set `__Host-ip_oauth`; 302 to `{GITEA}/login/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`. `return_to` must be a relative, non-API path; anything else becomes `/`. |
| GET | `/api/auth/callback` | Require `__Host-ip_oauth` (less than 10 minutes old) and a matching `state`; on Gitea `error`, 302 to `/login?error=denied`. Exchange the code at `{GITEA}/login/oauth/access_token` with `client_id`, `client_secret`, `code_verifier`, `redirect_uri`. `GET /api/v1/user`, then the org membership check: a non-member gets **no session** and a 302 to `/login?error=not_member`. Otherwise upsert `users`, set `__Host-ip_session`, delete `__Host-ip_oauth`, and 302 to `return_to`. Sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Other login errors: `expired`, `failed`, `unavailable`. |
| POST | `/api/auth/logout` | CSRF check; delete the session cookie; 204. |
| GET | `/api/auth/github/login?return_to=` | Set `__Host-ip_github_oauth`; 302 to `https://github.com/login/oauth/authorize` with `scope=read:user`. Works whether or not the caller is signed in (see below). |
| GET | `/api/auth/github/callback` | Finish GitHub OAuth; behaviour depends on whether a valid `__Host-ip_session` is already present (see "GitHub sign-in" below). |

- Each auth route is its own function file: for cross-origin requests `netlify dev` retries the path with `/index.html` appended, which breaks routing on `pathname` inside one function.
- `redirect_uri` is `{request origin}/api/auth/callback` (or `/api/auth/github/callback`). Confidential clients get an **exact** redirect match, so each origin must be registered on both the Gitea and the GitHub OAuth app: the production URL and `http://localhost:8888` (not `127.0.0.1`). Deploy previews are not registered, so sign-in does not work there (non-goal).
- **Scopes:** `read:user read:organization read:repository write:issue` for Gitea. Gitea 1.25 silently widens a token to *all* scopes if any requested name is invalid, so the scope string is a constant with a unit test. GitHub's OAuth App asks only `read:user` -- enough to read the account's id and username, nothing else -- since it is used for identity, not repo access.

### Auth wrapper -- `withAuth(handler)`

Accepts **either** the session cookie (browsers) **or** `Authorization: Bearer <Gitea token>` (Python scripts, integration tests, and background jobs). A bearer token is not an ambient credential, so bearer requests skip the CSRF check and never receive `Set-Cookie`.

1. **CSRF (cookie requests only).** For any method other than GET/HEAD/OPTIONS, require an `Origin` header equal to the request's own origin, `Sec-Fetch-Site` (when sent) of `same-origin`, and `Content-Type: application/json` when there is a body. Otherwise 403.
2. **Credentials.** Decrypt the session cookie, or read the bearer token. Missing, undecryptable, or past `SESSION_MAX_AGE_DAYS` -> 401 (and clear the cookie).
3. **Gitea-less gate (cookie requests only, decision 22).** A session with `gitea_id: null` (an account created directly by GitHub, not yet connected to Gitea) is refused here, before anything below touches Gitea: 403 `forbidden` with `details.reason = "gitea_required"`. Every tracked repo lives on Gitea, so there is nothing this wrapper's callers can do for such an account; `/api/me` is the one exception (below).
4. **Refresh (cookie requests only).** If `access_expires_at` is within **20 minutes**, POST `grant_type=refresh_token` with `client_id` + `client_secret`. On success, store the rotated tokens and re-issue the cookie on the response. If Gitea rejects the refresh token -> 401 and clear the cookie. On a network error or Gitea 5xx -> 502, keeping the cookie. The 20-minute margin guarantees any token forwarded to a background job outlives its 15-minute limit.
5. `GET {GITEA_BASE_URL}/api/v1/user` with the token; 401/403 -> 401. For cookie requests, the returned id must equal the session's `gitea_id`.
6. `GET /api/v1/orgs/{GITEA_ALLOWED_ORG}/members/{username}` without following redirects; only a direct 204 counts as membership, otherwise 403.
7. Upsert `users` by `gitea_id`, update `last_seen_at`.
8. Call `handler(req, { user, giteaToken, forge }, context)`, where `forge` is a `GiteaForge` bound to the token.

Tokens are held in memory for the request only. Log paths and statuses, never headers or cookies, and scrub the token from any logged error text.

### GitHub sign-in and account linking (decision 22)

One account, any number of linked forge identities -- Gitea plus GitHub now, GitLab and Bitbucket later -- any of which can sign in to the *same* account. The account itself can be created by **either** Gitea sign-in (as always) **or** GitHub sign-in; there is no primary forge. What is fixed is that every tracked repo lives on Gitea until Phase 9, so an account with no Gitea link yet can sign in and see who it is, but cannot use any Gitea-backed feature (all of them, today) until it connects Gitea too -- the web app shows a "Connect Gitea to continue" screen for that state (Section 8) instead of blocking sign-in outright.

`user_identities` (Section 4) holds every non-Gitea link: one row per `(user, forge)`, unique on `(forge, forge_user_id)` so a GitHub account can only ever link to one app account (`IdentityLinkedElsewhere`, `src/db/identities.ts`). Its `gitea_refresh_token_enc` is null until the account has a Gitea link; once it does, it holds a sealed snapshot of that account's Gitea **refresh token** (same pattern as Settings API keys, AAD `user_identities.gitea_refresh_token:<user_id>:<forge>`) -- what lets a later GitHub sign-in mint a real Gitea session with no Gitea prompt.

A second, independent allow-list, `GITHUB_ALLOWED_USERS`, is GitHub's access gate: there is no GitHub org equivalent to `GITEA_ALLOWED_ORG` to check against, so every GitHub sign-in or link checks this list first, whether or not it ends up touching Gitea.

`GET /api/auth/github/callback` (`src/auth/githubHandlers.ts`) reads any existing `__Host-ip_session` cookie *before* doing anything else, and branches on it:

- **A valid session is present (link mode):** the caller is already signed in (with or without a Gitea link). Exchange the code, fetch the GitHub user, check the allow-list, then upsert `user_identities` with the session's *current* Gitea refresh token as the snapshot (null if the signed-in account has none itself yet). `github_already_linked` if that GitHub account already links to a different user.
- **No valid session (login mode):** exchange the code, fetch the GitHub user, check the allow-list, then look up `user_identities` by `(github, forge_user_id)`:
  - **Not found:** create a brand-new account (`users.gitea_id = null`) and link this GitHub identity to it, Gitea-less. This is the only way an account can exist with no Gitea link at all.
  - **Found, no Gitea link (`gitea_refresh_token_enc` null):** sign straight into that account -- no Gitea call, nothing to refresh.
  - **Found, with a Gitea link:** decrypt the stored refresh token and call Gitea's own `refresh_token` grant (`src/auth/oauth.ts::refreshTokens`, the same one `withAuth` uses). A rejected refresh (revoked, expired) -> `github_link_expired`. On success, `GET /api/v1/user` and **re-run the `GITEA_ALLOWED_ORG` membership check** with the fresh token -- a GitHub sign-in re-verifies org membership exactly like a direct Gitea sign-in, so someone removed from the org loses access through either door. Build and set `__Host-ip_session` exactly as `handleCallback` does, and overwrite the stored snapshot with the rotated refresh token (`touchGithubIdentityToken`) -- otherwise the next GitHub sign-in would fail.

**The reverse direction** -- an account created by GitHub connecting Gitea afterward -- runs through the *existing* `GET /api/auth/callback` (Gitea's own), which now does the same existing-session check: a valid but Gitea-less session at callback time means "attach this Gitea identity to my account" (`linkGiteaToUser`, `src/db/users.ts`) instead of the normal create-or-find-by-`gitea_id` (`upsertUser`). The org membership check still runs first either way. `gitea_already_linked` if that Gitea account already belongs to a different user; `linkGiteaToUser` is otherwise idempotent for a repeat of the same link.

Both callbacks share the `LoginError` vocabulary (`/login?error=...`), Gitea's own codes plus `gitea_already_linked` and the `github_`-prefixed ones, so the login screen can tell every failure apart. See `src/auth/github.ts` (GitHub OAuth mechanics), `src/auth/githubHandlers.ts` (GitHub's two branches), `src/auth/handlers.ts` (Gitea's link-mode addition), and `src/db/identities.ts` / `src/db/users.ts`.

`GET /api/settings/connections` lists the caller's linked forges (username, linked-at, never the token); `DELETE /api/settings/connections/:forge` unlinks one (does not touch the account's Gitea link either way).

### `withAccount(handler)` -- the one Gitea-less-safe wrapper

`GET /api/me` (`src/auth/withAccount.ts`) is deliberately lighter than `withAuth`: it decrypts the session and loads the `users` row by id, with **no Gitea call at all** -- no refresh, no org re-check. That is the only way a Gitea-less account can learn who it is signed in as and get routed to "Connect Gitea to continue" (Section 8) instead of an opaque 403. It grants nothing beyond that: every other endpoint stays behind `withAuth`, which does require Gitea and re-checks `GITEA_ALLOWED_ORG` on every request. One consequence: a Gitea-linked account that loses org membership mid-session now finds out on its next *data* call rather than on `/api/me` itself -- `/api/me` no longer re-verifies org membership, since it must also work without Gitea at all.

### `ForgeClient` interface (`src/forge/types.ts`)

```ts
interface ForgeClient {
  getCurrentUser(): Promise<{ id: number; username: string; fullName?: string }>;
  isOrgMember(org: string, username: string): Promise<boolean>;
  listAccessibleRepos(query?: string): Promise<RepoRef[]>;
  getRepo(owner: string, repo: string): Promise<{ defaultBranch: string; hasIssues: boolean; empty: boolean }>;
  getBranchHead(owner: string, repo: string, branch: string): Promise<string>; // sha
  getTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]>;     // blobs only, all pages
  getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  listLabels(owner: string, repo: string): Promise<{ id: number; name: string }[]>; // repo labels + the owning org's labels
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<{ number: number; url: string }>;
  addDependency(owner: string, repo: string, issue: number, dependsOn: number): Promise<void>;
  listIssuesCreatedBySince(owner: string, repo: string, username: string, since: Date): Promise<{ number: number; body: string; url: string }[]>;
}
```

`GiteaForge` retries 429/5xx and network errors with jittered backoff (3 attempts) and throws a typed `ForgeError { status, retryable }`, **except `createIssue`**, which makes a single attempt: retrying a POST that timed out or 5xx'd could create a duplicate issue, so an ambiguous failure there is left for the caller (`postDraft`) rather than retried underneath it. There is no `listIssueTemplates`: templates are read from the tree (Section 6).

### Endpoints

| Method | Path | Kind | Status | Behaviour |
|---|---|---|---|---|
| GET | `/api/health` | sync | built | DB ping; no auth |
| GET | `/api/auth/login`, `/api/auth/callback` | sync | built | See "Auth endpoints"; no auth |
| POST | `/api/auth/logout` | sync | built | Clear session |
| GET | `/api/me` | sync | built | Current user |
| GET | `/api/gitea/repos?q=` | sync | built | Repos the user can see in Gitea (for the picker) |
| GET | `/api/repos` | sync | built | Tracked repos |
| POST | `/api/repos` | sync | built | `{owner, name}` -> verify access via forge (and that issues are enabled and the repo is not empty), insert; 201 new, 200 already tracked |
| GET | `/api/repos/:id/labels` | sync | built | Repo + org labels, live from Gitea, for the label picker |
| POST | `/api/raw-issues` | sync | built | `{repo_id, body}` -> rate-limit check, insert raw issue + run in one batch, trigger drafting job, return `{run_id}` (a failed trigger marks the run failed) |
| GET | `/api/runs?limit=` | sync | built | The team's workflow queue, newest first: repo, author, notes excerpt, status/error, draft counts by status (default 50, max 200) |
| GET | `/api/runs/:id` | sync | built | Status, error, draft ids, tokens, `model_draft`; marks a run failed when it has been active or queued for over 17 minutes |
| POST | `/api/runs/:id/retry` | sync | built | Only `failed` runs -> reset to `queued`, re-trigger as the caller |
| GET | `/api/drafts?repo_id=&run_id=&status=` | sync | built | Drafts with repo, deps (id, title, status, gitea number), author and approver usernames; all filters optional (max 500) |
| GET | `/api/drafts/:id` | sync | built | Detail: dependencies, dependents, events with actors |
| PATCH | `/api/drafts/:id` | sync | built | `{title?, body?, labels?, version}`; labels must exist in Gitea; 409 on version or status mismatch |
| PUT | `/api/drafts/:id/deps` | sync | built | `{depends_on_ids, version}`; same-repo + cycle check (application and database) |
| POST | `/api/drafts/:id/approve` | sync | built | `{version}` -> `draft -> approved`, sets `approved_by`; 409 if the draft changed since that version |
| POST | `/api/drafts/:id/unapprove` | sync | built | `approved -> draft`, clears `approved_by` |
| DELETE | `/api/drafts/:id` | sync | built | Only `draft`; 204 |
| POST | `/api/drafts/:id/retry` | sync | built | `failed -> approved` |
| POST | `/api/drafts/:id/post` | sync | built | Post one draft now (Section 7); only throws if the claim itself is refused (409) -- every other outcome is persisted and returned in the draft |
| POST | `/api/drafts/:id/reconcile` | sync | built | Resolve a stuck `posting`, or retry unlinked dependency links on a `posted` draft (Section 7) |
| POST | `/api/repos/:id/post-queue` | sync -> bg | built | Trigger background posting of every ready draft in the repo |
| GET | `/api/templates` | sync | built | The team's app templates (content, derived `file` name, forges, kind, version, creator/editor usernames) |
| POST | `/api/templates` | sync | built | `{name, forges, kind, content}`; the kind must suit every forge; content must pass `checkTemplate`; 409 `name_taken` |
| GET, PATCH, DELETE | `/api/templates/:id` | sync | built | PATCH replaces with `{..., version}`, 409 `stale` when someone saved first; DELETE removes it (raw issues' `template_id` is nulled, runs keep their snapshot). Anyone in the org may edit or delete |
| POST | `/api/template-preview` | sync | built | `{kind, content, forges}` -> `{errors, warnings, template}` parsed as drafting will read it; saves nothing (not `/api/templates/preview`, which would collide with `:id`) |
| GET | `/api/settings/ai` | sync | built | The caller's AI settings: chosen provider (null = team default) and, per provider, models, `has_key`, `key_last4`, whether a team key exists, default models. Never a key |
| PUT | `/api/settings/ai` | sync | built | `{provider}` (null = team default) |
| PUT | `/api/settings/ai/:provider` | sync | built | `{model_select, model_draft, api_key?, clear_key?}`; the key is sealed before storage and never returned |
| GET | `/api/settings/ai/:provider/models` | sync | built | Live model list from the provider, with the caller's key or the team's; 400 when neither exists or the key is rejected |
| POST | `/api/settings/ai/:provider/test` | sync | built | One small structured-output call per saved model; always 200 with `{ok, message}` |

Errors use one shape: `{ error: { code, message, details? } }`. 409s from review writes (edit/approve/unapprove) carry `details: { reason: "status" | "stale", status, version }`. Posting endpoints use their own reason codes instead, since the failure modes differ: `post` can refuse with `status`, `unposted_deps`, or `claimed`; `reconcile` with `not_stale`. Shared zod schemas for every request/response live in `packages/shared`. No endpoint emits CORS headers.

### Background functions

| Function | Path | Status | Triggered by |
|---|---|---|---|
| `draft-run-background` | `/internal/draft-run` | built | `POST /api/raw-issues`, `POST /api/runs/:id/retry` |
| `post-queue-background` | `/internal/post-queue` | built | `POST /api/repos/:id/post-queue` |

- Background mode comes from the `-background` filename suffix.
- The sync endpoint calls `fetch` against `{request origin}/internal/...` (production, preview, or `netlify dev`). It sends `x-internal-secret: INTERNAL_JOB_SECRET`, the caller's current (already refreshed) access token as `Authorization: Bearer`, and a JSON body with the id. It awaits only the 202. The token travels server-to-server only.
- Background functions reject any request without a matching secret (constant-time compare) and then run `withAuth` on the bearer token, so org membership is re-checked. A 401/403 there marks the run failed ("sign in again and retry"); a 5xx is thrown for a platform retry.
- **Retries (`draft-run-background`):** Netlify retries a background function that throws, after 1 minute and again after 2 more. Deterministic failures (validation errors, 4xx from Gitea or the AI provider, bad AI output after repair, a prompt too large for the model) mark the run `failed` and **return normally**. Transient failures (network, 429, 5xx) are thrown so the platform retry applies, except on the last attempt, which marks the run `failed` with "This looks temporary: retry the run in a minute." Every job is idempotent.
- **Retries (`post-queue-background`):** it never throws to trigger a platform retry. Each draft is claimed atomically before posting, so a race with a manual `POST /api/drafts/:id/post` (or a second queue run) just moves on to the next ready draft instead of erroring the whole batch; the loop itself stops on the conditions in Section 7 (none ready, 50 posts, 3 consecutive failures).
- **Local dev:** `netlify dev` never replays failed background functions, so `draft-run-background` runs with one attempt there and fails transient errors at once instead of leaving the run in progress. `post-queue-background` is unaffected, since it does not rely on platform retries.
- **Token lifetime:** Gitea access tokens last 1 h. The 20-minute refresh margin in `withAuth` means the forwarded token has at least 20 minutes left when the job starts, which covers the 15-minute background limit.

---

## 6. Stage 1 -- Drafting pipeline (`pipeline/draft.ts`)

Runs inside `draft-run-background`. Updates `runs.status` at each step so the UI can show progress.

1. **Claim (idempotent).** `UPDATE runs SET status = 'reading_repo', attempts = attempts + 1, started_at = now() WHERE id = $1 AND status NOT IN ('done', 'failed')`. Zero rows -> exit quietly.
2. **Resolve head.** `getRepo` (fail if empty; update a changed default branch) -> `getBranchHead(default_branch)` -> `commit_sha`; store it on the run.
3. **Snapshot (cached).** If `repo_snapshots(repo_id, sha)` exists, reuse it. Otherwise:
   - `getTree(sha)` recursively (`recursive`, `page`, `per_page` 1000), paging until Gitea stops reporting `truncated`.
   - Filter out `node_modules/`, `dist/`, `build/`, `.git/`, `vendor/`, lockfiles, minified bundles, binaries/media by extension, and files over 200 KB.
   - Fetch `README*` at root (first match, capped at 50,000 characters) and `ROUTING.md` at root (any case, capped at 30,000 characters with a truncation note).
   - Fetch issue templates **at the snapshot sha** from the full tree, using Gitea's own directory order (`ISSUE_TEMPLATE`, `issue_template`, `.gitea/ISSUE_TEMPLATE`, `.gitea/issue_template`, `.github/...`, `.gitlab/...`; the first directory with templates wins; `config.yml` skipped). Gitea 1.25's `issue_templates` endpoint has no `ref` parameter, so it is not used. Markdown templates are front matter + body. YAML issue forms are parsed with `yaml` into fields (label, type, required, options) and a Markdown skeleton of `### <field label>` sections, matching how Gitea renders a submitted form (empty optional fields become `_No response_`).
   - Fetch labels (repo + org).
   - Insert the snapshot row (`ON CONFLICT DO NOTHING`).
4. **Select files** (`status = 'selecting_files'`, the provider's select model). Input: raw issue text, `ROUTING.md` (the model treats it as the authoritative map of where each area lives), README excerpt (<= 8,000 chars), and the filtered path list with sizes. Output `{ paths: string[] }`; unknown paths are dropped and at most 20 kept. A repo with more than 8,000 readable files fails with a readable error.
5. **Fetch context.** `getRawFile(path, ref = sha)` for each selected path (5 at a time), skipping files that vanished or contain NUL bytes. Truncate each file to 400 lines and the total to ~150,000 characters, noting truncation inline.
6. **Draft** (`status = 'drafting'`, the provider's draft model). Input: raw issue, repo name, `ROUTING.md`, selected file contents, template descriptions (for forms: each section, required or optional, exact dropdown options), label names. When the run has a `template_snapshot` (an app template picked at submission), that one template replaces the repository's templates for the prompt, validation, dropdown snapping, and template labels; drafts record its derived file name (e.g. `bug-report.md`) as `template_name`. A snapshot that no longer parses fails the run with guidance. Output:

   ```json
   {
     "drafts": [
       {
         "key": "a",
         "title": "string (<= 255)",
         "body": "markdown that follows the chosen template's sections",
         "template_name": "feature-task.yml | null",
         "labels": ["only names from the provided label list"],
         "depends_on": ["other draft keys"]
       }
     ],
     "reviewer_notes": "string | null"
   }
   ```

   Prompt rules: 1-8 drafts; split only when work is genuinely separable; use the routing file for areas and "Files / components affected"; cite concrete file paths from the provided context; never invent labels; `depends_on` must reference keys in this response and be acyclic.
7. **Validate.** First snap near-miss dropdown answers to the exact option (an answer matching exactly one option once emoji, case, and punctuation are ignored, e.g. `BUG` -> the option with the bug emoji). Then check: draft count, unique keys, title length, body not empty, labels in the whitelist, dependency keys exist and are acyclic, `template_name` is a real template (or null when the repo has none), and for issue forms every section is present, in order, required fields answered, dropdown values from the options. On failure, make **one** repair call with the errors. Still invalid -> run `failed` with the first errors.
8. **Sanitize.** Strip any `<!-- issue-pipeline:` markers from AI output so a model can't forge the posting marker, trim, and add the template's own labels when they exist in the repo.
9. **Commit (atomic).** One transaction: insert drafts (`created_by` = raw issue author) off an `UPDATE runs SET status = 'done', ... WHERE status = 'drafting' RETURNING id` CTE, then `draft_deps` and `created` events only for drafts that exist. A duplicate or late invocation writes nothing. The run records token totals, `prompt_version`, and `provider/model` ids; `reviewer_notes` go into each `created` event's detail.

### AI providers (`src/llm`)

Both calls go through one `LlmClient` interface. `draft-run-background` resolves the provider for the user who triggered the run (whoever submitted or retried it) with `llmConfigForUser` (`src/settings/ai.ts`):

1. No provider chosen in Settings -> the team default from `LLM_PROVIDER` with its env key and models.
2. A provider chosen -> the user's own key for it, else the team's env key for that provider; the user's models, else the provider's env models, else built-in defaults (Anthropic and Gemini only).
3. Anything missing (no key anywhere, no models, an undecryptable saved key) is an `AiSettingsError`: the run is marked `failed` with a message saying what to fix in Settings, and it is not retried.

| Provider | Transport | JSON output | Notes |
|---|---|---|---|
| `gemini` | REST `models/{model}:generateContent` with `x-goog-api-key` | `generationConfig.responseJsonSchema` (from the zod schema) | Thought parts ignored; the model turn (with thought signatures) replayed verbatim for the repair call. The client retries 503 "high demand", rate-limit 429s, and network errors up to 4 attempts (~2 s, 4 s, 8 s backoff). Depleted prepaid credits (429) are not retried and get a message pointing to AI Studio |
| `anthropic` | `@anthropic-ai/sdk`, streamed | Structured outputs (`output_config.format`) | Top-level prompt caching so the repair turn re-reads the repository context cheaply. SDK retries transient errors |
| `lmstudio` | `@anthropic-ai/sdk` pointed at LM Studio's Anthropic-compatible `/v1/messages` | Forced tool call (`tool_choice: any`) with a JSON schema | Local development only, env only (not offered in Settings). No caching. Prompt budgeting applies (below) |
| `openai`, `grok`, `venice` | Plain REST `POST {base}/chat/completions` with a bearer key; fixed base URLs (`api.openai.com/v1`, `api.x.ai/v1`, `api.venice.ai/api/v1`) | `response_format: {type: "json_schema", strict: false}` (strict mode rejects the draft schema's optional fields); a Markdown-fenced JSON reply is unwrapped | Token cap sent as `max_completion_tokens` (OpenAI, Venice) or `max_tokens` (xAI). Venice gets `venice_parameters.include_venice_system_prompt: false`. Retries 429 (not exhausted quota), 5xx, and network errors up to 4 attempts. The repair turn replays the assistant's JSON text |

**Prompt budgeting** (`pipeline/budget.ts`) applies when the provider reports a context size (LM Studio). Tokens are estimated at ~3 characters each. The file list for the selection call shrinks from paths with sizes, to bare paths, to a ranked subset: paths named in `ROUTING.md` first, then the best name matches for the notes; the prompt says the list is partial. The drafting call's file context is sized to leave room for the drafts and one repair turn. If even the fixed prompt parts do not fit, the run fails with guidance to load the model with a larger context.

**Errors** are described for the run page: a context overflow names both token counts; other provider errors show the provider's own message (errors raised inside a stream have no HTTP status, so the message is read from the body).

**Prompts** live in `apps/api/prompts/` as TS modules exporting template strings (avoids bundling non-TS files), named with a version (`selectFiles.v1.ts`, `draftIssues.v1.ts`). Runs record the draft prompt version.

**Untrusted input.** Raw issue text, the README, `ROUTING.md`, and repo files are data, not instructions. They are wrapped in delimited tags and the model is told to ignore instructions inside them. The real control is the human approval gate: nothing reaches Gitea without `approved`.

---

## 7. Stage 2 -- Posting (`pipeline/post.ts`, no AI)

### `postDraft(draftId, actorId, forge, store)`

Like `runDraftJob` (Section 6), this takes the store it needs as a plain object of injected functions, so it is unit-tested against fakes rather than a live database (`pipeline/post.test.ts`).

1. **Claim** with the atomic UPDATE (Section 4). Zero rows -> 409 with the specific reason (`status`, `unposted_deps`, or `claimed`).
2. **Build body:** `draft.body`, then a `**Depends on:** #12, #15` line using the dependencies' `gitea_number`s (if any), then the hidden marker `<!-- issue-pipeline:draft:{draft_id} -->`. *(Still open: when the template has a "Dependencies / blockers" section, insert the links there instead -- see Section 13.)*
3. **Labels:** map names -> ids from `listLabels`; drop unknown names and record them in the event detail.
4. **Create:** `createIssue` with the user's token, so the issue is authored by that user.
5. **Record immediately:** `UPDATE drafts SET status='posted', gitea_number, gitea_url, updated_at WHERE id = $1 AND status = 'posting'`, plus a `posted` event.
6. **Link dependencies:** for each dependency, `addDependency(issue, depends_on_number)` -> set `linked_in_gitea = true`. A failure here does not undo the post; record a `link_failed` event (reconcile retries it). **VERIFY** that issue dependencies are enabled on each target repo (the API endpoints exist on Gitea 1.25).

Error handling:

- Failure **before** step 4, or a definite 4xx from step 4 -> `failed` with `last_error`.
- Ambiguous failure **during** step 4 (timeout, connection reset, 5xx) -> leave the draft in `posting`; reconcile decides.

### `reconcileDraft(draftId, actorId, forge, store)`

Allowed when the draft is `posting` and `claimed_at` is older than 5 minutes, or when a `posted` draft has unlinked dependencies; otherwise 409 (`reason: "not_stale"`).

1. `listIssuesCreatedBySince(claimed_by.username, claimed_at - 1 min)` (Gitea list-issues `created_by` + `since`) and search bodies for the draft's marker.
2. Found -> mark `posted` with that number. Not found -> return to `approved`.
3. Retry any dependency links where `linked_in_gitea = false` and both sides are posted.
4. Record a `reconciled` event with the outcome.

### Post queue (`post-queue-background`)

Loop: select the oldest `approved` draft in the repo whose dependencies are all `posted`; `postDraft` it; repeat. Stop when none are ready, after 50 posts, or after 3 consecutive failures. Because each iteration re-checks readiness, dependencies are posted before dependents without an explicit topological sort.

---

## 8. Web app (`apps/web`)

TypeScript + Vite + React + TanStack Query + `react-markdown`. Types and zod schemas come from `packages/shared`. Routing is a tiny history-API router (`lib/router.ts`); there is no router dependency.

### API access (`lib/api.ts`)

- Same-origin `fetch` only. The browser attaches the session cookie automatically; the app never reads or stores a token, and uses no `localStorage` for credentials.
- Requests with a body send `Content-Type: application/json` (the browser adds `Origin`), which satisfies the CSRF check.
- Every response is parsed with its shared zod schema; errors map to the shared error shape.
- Queries retry only network errors and 5xx (twice). A 4xx or a response that fails its schema is shown at once rather than hidden behind silent retries.
- A `401` from any query re-checks `/api/me`, which returns the app to the sign-in screen. A `403` from the org gate shows a "no access" screen with a sign-out button.

### Sign-in

- "Sign in with Gitea" and "Sign in with GitHub" are plain navigations (`/api/auth/login?return_to=...`, `/api/auth/github/login?return_to=...`, not `fetch`), so each OAuth flow is top-level redirects. Either can create the account (decision 22); "Sign in with GitLab" is shown disabled ("coming soon", Phase 10).
- `/login?error=` renders an explanatory message: `denied`, `not_member`, `expired`, `failed`, `unavailable`, `gitea_already_linked` for Gitea; `github_denied`, `github_expired`, `github_failed`, `github_unavailable`, `github_not_allowed`, `github_link_expired`, `github_already_linked` for GitHub (Section 5).
- On load, `GET /api/me` (`withAccount`, not `withAuth` -- Section 5) decides between the sign-in screen (401), the signed-in app (`gitea_id` set), and "Connect Gitea to continue" (`gitea_id: null`, decision 22).

### Screens

| Screen | Path | Contents |
|---|---|---|
| Sign in | `/login` | "Sign in with Gitea", "Sign in with GitHub" buttons (either creates the account, decision 22); "Sign in with GitLab" shown disabled; error states |
| Connect Gitea | shown instead of the app | For a signed-in, Gitea-less account (created by GitHub, decision 22): explains that every tracked repo lives on Gitea, a "Connect Gitea" button (the same Gitea OAuth flow, now in link mode -- Section 5), and Sign out |
| New issue | modal from the nav bar | Repo select, template select ("Repository's own templates" by default, or an app template offered for the repo's forge), notes text area -> submit -> lands on the Queue with the new run expanded. The run detail shows which template was used |
| Queue | `/queue`, `/queue/<run id>` | Every run, in-progress first, then recent: status pill, repo, author, time, notes excerpt, error, draft counts by status. Clicking a row expands its progress steps, commit, model, tokens, notes, retry (when failed), and drafts (rendered Markdown, linked to the editor). Old `/runs/<id>` links redirect here |
| Board | `/board?repo=<id>` | Columns by status: Draft, Approved, Posting, Posted, Failed; repo filter (or all repos). Cards: title, repo, labels, "Blocked by N unposted drafts", issue number, approver |
| Draft editor | `/drafts/<id>` | Status, repo, template, author, approver, Gitea link. While `draft`: title, body with Write / Preview tabs, label chips (repo labels live from Gitea), dependency checkboxes (same-repo drafts with their status), Save, Approve (disabled while there are unsaved changes), Delete with inline confirm. While `approved`: read-only view with Unapprove. "Needed by" list and event history. A stale save or approval shows **"Edited by someone else"** with Reload; the editor also polls every 15 s and flags a newer version if the form has unsaved edits |
| Repositories | `/repos` | Tracked repos; search accessible repos and track one (disabled for archived repos or repos with issues turned off) |
| Settings | `/settings/ai`, `/settings/connections`, `/settings/templates` | Sub-tabs. **AI model:** radio list of "Team default (<provider>)", Anthropic, Gemini, Grok, OpenAI, Venice (saved on click, badges for "your key" / "team key"). Choosing a provider shows its panel: API key (password field; a saved key shows only "ending in ...abcd" with Replace/Remove), select and draft model fields with suggestions listed live from the provider (free text allowed), Save, and Test (disabled while unsaved). A warning shows when neither the user nor the team has a key. **Templates:** list of team templates (format and forge badges, derived file name, last editor) with New and Edit. The editor has name, "Offered for" forge chips, format radios (Issue form disabled when a Markdown-only forge is chosen), a monospace content area with "Start from an example", and a live preview from `/api/template-preview`: errors (which disable Save), notes, title prefix/about/labels, then the rendered Markdown body or the form's `### label` sections with type, required, and options. Save handles a stale version with Reload; Delete asks inline and says existing runs keep their copy. **Connections:** one row per connectable forge (GitHub, GitLab, Bitbucket) with a Connect or, once linked, "linked as \<username\>" and Disconnect; GitLab and Bitbucket show "coming soon" and no working Connect button until Phases 10-11 |
| Card actions | built | Post and Unapprove on `approved` drafts, Retry on `failed`, Reconcile on `posting` (all in the draft editor); "Post all ready" on the board, scoped to the selected repo |

**Markdown renders AI-written text, so it must not render raw HTML.** `components/Markdown.tsx` uses `react-markdown` with `skipHtml` and its default URL filter, and opens links in a new tab with `rel="noopener noreferrer"`. A test asserts script tags, event handlers, and `javascript:` links never reach the page. GitHub-flavoured extras (task-list checkboxes, tables) would need `remark-gfm`, not added; `- [ ]` checklists currently render as plain text in the preview.

### Security headers

- `netlify.toml` headers on every path: `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (the OAuth callback overrides with `no-referrer`).
- The production build adds a CSP `<meta>` tag: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`. It is not applied in development because Vite's dev server needs inline scripts, and `frame-ancestors` cannot be set from a meta tag.
- API responses send `Cache-Control: no-store`.

---

## 9. Deployment -- Phase 5

1. **One Netlify site** built from git `main` (the site's configured production branch; `dev` is the ongoing development branch): build command compiles `packages/shared` and `apps/web`; `publish = apps/web/dist`; `functions = apps/api/netlify/functions`. No base directory. `netlify.toml` at the repo root already has this -- **done**. (History: on 2026-09-14 git's `main` was briefly renamed to `dev` and a separate `prod` branch created for Netlify to build from; that `prod` branch was deleted the same day and the plan reverted to this conventional `main`-is-production / `dev`-is-ongoing-work setup. `origin/prod` may still exist as a stale remote branch -- delete it if so.)
2. **Environments:** production uses the Neon project's `main` branch (its default/primary database branch); local dev (`netlify dev`) uses the Neon `dev` branch. **These are Neon database branches, unrelated to the git `main`/`dev` branches in item 1** -- both happen to use the same two names, which is a coincidence worth double-checking against whenever an instruction just says "main" or "dev." Migrations are applied with `pnpm db:migrate` before a deploy that needs them. **Done (2026-09-14):** the Neon `main` branch had zero tables (only the Neon `dev` branch had ever been migrated); `pnpm db:migrate` was run against it and all 8 tables plus `drizzle.__drizzle_migrations` now exist.
3. **Gitea OAuth app:** confidential client with redirect URIs `https://issue-pipeline.netlify.app/api/auth/callback` and `http://localhost:8888/api/auth/callback`. **Site created (2026-09-14); redirect URI registration still outstanding** -- an admin needs to add the production URI in Gitea now that it's known.
4. **Secrets** (`GITEA_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY`, `DATABASE_URL`, `INTERNAL_JOB_SECRET`) live only in Netlify environment variables and the local, gitignored `.env`. Use different `SESSION_SECRET` values per environment. **Netlify site created** (`issue-pipeline.netlify.app`, project id in `.env` as `NETLIFY_PROJECT_ID`, set up by Kayela); **env vars not yet confirmed set**.
5. **AI provider:** the team default `LLM_PROVIDER` may be any provider except `lmstudio`, which refuses to run outside `netlify dev`. `CREDENTIALS_KEY` (different per environment) must be set before anyone saves a key in Settings -- set locally and on Netlify, and migration `0002` applied to the Neon `main` branch (2026-09-14).
6. **Key rotation:** set the new key as `SESSION_SECRET` and the old one as `SESSION_SECRET_PREVIOUS`; remove the old key after `SESSION_MAX_AGE_DAYS`.
7. **Deploy previews** build and serve the UI and `/api/health`, but sign-in is unsupported there (their URLs are not registered redirect URIs).
8. **Smoke test:** `scripts/smoke_test.py` (Python, `requests`) runs the full path -- track a repo, submit notes, wait for drafting, approve, post -- against a deployed site using a bearer PAT (`pip install -r scripts/requirements.txt`, then see the script's docstring for usage). **Built, not yet run** -- needs the OAuth redirect URI and env vars in place first: `python scripts/smoke_test.py --base-url https://issue-pipeline.netlify.app --token <PAT> --owner <org> --repo <repo>`.

---

## 10. Security checklist

- [ ] The client bundle contains no secrets and no build-time configuration.
- [ ] Gitea tokens exist only inside the encrypted `HttpOnly` session cookie and in request memory; never in Postgres, logs, URLs, or JavaScript-readable storage.
- [ ] Session cookie: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, AES-256-GCM with cookie-name AAD, absolute max age enforced server-side.
- [ ] OAuth: `state` + PKCE S256, confidential client, exact redirect URIs, `return_to` restricted to relative paths, non-members get no session.
- [ ] CSRF: `Origin` must match on every cookie-authenticated non-GET request; JSON content type required for bodies.
- [ ] Org membership checked on every request, including inside background functions.
- [ ] `/internal/*` requires `INTERNAL_JOB_SECRET` (constant-time compare).
- [ ] Nothing posts to Gitea without an `approved` status set by a human, and approval applies only to the version the approver reviewed.
- [ ] AI output sanitized (marker stripping, label whitelist, length limits) and Markdown rendered without raw HTML.
- [ ] AI provider keys server-side only. Keys saved in Settings are AES-256-GCM ciphertext bound to column, user, and provider; the API returns only `has_key` and the last 4 characters; provider base URLs are fixed, never user-supplied.
- [ ] Per-user daily run cap enforced from the `runs` table.
- [ ] Input size limits enforced by zod on every endpoint (request bodies capped at 64 KB).
- [ ] No CORS headers anywhere; security headers (CSP, `frame-ancestors 'none'`, `nosniff`, referrer policy) set.

---

## 11. Testing

Run everything with `pnpm -r test`. Current coverage:

- **Unit (vitest, `apps/api`):**
  - Session crypto (round trip, tampering, wrong key, rotation, AAD swap, max age, size under 4 KB); CSRF; OAuth helpers, login, callback (state mismatch, stale, denied, non-member, rejected exchange), `return_to` validation; `withAuth` (bearer and cookie, refresh success/rejected/transport error, org gate, token never logged).
  - `GiteaForge`: retries, tree paging, raw-file path encoding, org label merge, membership redirects, single-attempt `createIssue` (never retries a 5xx), dependency links, paging issues by creator and time.
  - Template parsing against the real `feature-task.yml` (CRLF, emoji), Markdown templates, template discovery order.
  - Draft validation, dropdown snapping, sanitizing, cycle detection, tree filtering, README/ROUTING.md discovery.
  - Prompt budgeting: file-list fallbacks, routing-aware ranking, too-small context failure.
  - Stage 1 job with an in-memory store: key -> id mapping, snapshot reuse, one repair then failure, deterministic vs transient failures, platform retry producing drafts exactly once, last-attempt give-up, local dev single attempt, ROUTING.md reaching both calls.
  - AI clients: Anthropic structured vs tool mode, tool-result pairing on repair, stop reasons; Gemini schema requests, thought handling, repair replay, retries on 503/429, depleted credits not retried, error descriptions (including the LM Studio context-overflow message).
  - Review rules: dependency checks and refusal reasons.
  - App templates: derived file names, the real TrueRoster form accepted, unreadable YAML / missing body / no sections / duplicate ids / option-less dropdowns as errors, skipped fields and Bitbucket labels as warnings, snapshot parsing; the drafting job using a run's app template instead of the repository's (prompt, labels, `template_name`), rejecting drafts that pick the repository's template, and failing an unparseable snapshot. Live (`LIVE_DB=1`): name uniqueness, version-guarded update, snapshot copied onto a run and kept after the template is deleted.
  - Stored credentials: round trip, binding to user/provider/column, previous-key rotation, tampering. Provider resolution: team default, user key and models, team-key fallback, missing key or models as `AiSettingsError`. OpenAI-compatible client: URLs, token-cap field per provider, Venice parameters, repair replay, fenced JSON, refusal/length/empty output, retries, exhausted quota not retried, error descriptions. Live model-list parsing per provider (OpenAI non-chat filtering, Venice schema capability).
  - `postDraft`/`reconcileDraft` with an in-memory store and `fakeForge`: claim refusal reasons, label id mapping and dropped-label recording, an ambiguous `createIssue` failure left `posting` instead of guessed at, a definite failure marked `failed`, a link failure recorded without undoing the post, reconcile finding (or not finding) the marker on Gitea, and retrying unlinked dependency links.
- **Unit (vitest, `apps/web`):** API wrapper error mapping; Markdown renders structure but never raw HTML or `javascript:` links.
- **Unit (vitest, `packages/shared`):** queue response schema accepts partial draft counts.
- **Live, opt-in:**
  - `LIVE_DB=1` against the Neon dev branch: run claim, guarded draft commit (a duplicate commit writes nothing), queue listing, snapshots with `routing`, requeue rules, review writes (stale edit refused, approved drafts read-only until unapproved, database-level cycle guard with the application check bypassed, delete rules), and posting (the atomic claim skips a draft with an unposted dependency and cannot be taken twice, mark posted/failed, retry back to approved, reconcile to posted or approved from a simulated stale `claimed_at`, dependency link marking, link-failure and reconciled-links events).
  - `LIVE_LLM=1` against the configured provider: both Stage 1 calls with the real issue form.
- **Not yet built:**
  - **Integration:** a local Gitea in Docker (`gitea/gitea`) seeded by `scripts/seed_gitea.py` (Python, `requests`) with an admin token, a test org and users, a repo with a Markdown template and a YAML form, labels, and issue dependencies enabled. Tests authenticate with personal access tokens as `Authorization: Bearer`.
  - **Failure injection:** kill the process between `createIssue` and the DB update against a real Gitea, then run reconcile and assert no duplicate issue. `postDraft`'s handling of an *ambiguous* `createIssue` failure is covered by a unit test with a fake that throws; this is the harder end-to-end version against real process death and a real Gitea, which needs the Docker integration environment above.
  - **Smoke (Phase 5):** `scripts/smoke_test.py` runs raw issue -> drafts -> approve -> post against a deployed environment, using a bearer PAT.

---

## 12. Build phases

Each phase ends with its acceptance criteria passing and a short summary back to Kayela.

### Phase 0 -- Scaffold -- DONE (`82555e7`, as Tauri)
- pnpm monorepo, `packages/shared`, Netlify site with `/api/health`, Drizzle schema + first migration applied to the Neon dev branch, and a Tauri app calling `/api/health`. The Tauri shell was replaced in Phase 1.

### Phase 1 -- Web shell and auth -- DONE (`df4b774`)
- Client moved to `apps/web` served by `netlify dev` on one origin; session crypto, `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`, `withAuth` (cookie or bearer, CSRF, refresh, org gate), `/api/me`, security headers, sign-in screen.
- **Accepted 2026-09-12:** sign-in at `http://localhost:8888` persists across browser restarts and sign-out clears it; a non-member is refused a session; a cross-origin POST is rejected; no token appears in JavaScript-readable storage, responses, the address bar, or logs.

### Phase 2 -- Repos and drafting -- DONE (`e05e717`)
- Full read-side `ForgeClient`, repo tracking, snapshot caching, both AI calls, validation/repair, background job with idempotency and retry rules.
- Added during the phase: env-selected AI provider (Gemini, Anthropic, LM Studio), `ROUTING.md` convention and migration `0001`, prompt budgeting, dropdown snapping, the Queue page with runs expanding in place.
- **Accepted 2026-09-13:** a real run on `TrueRoster/frontend` produced a valid draft following `feature-task.yml` with `gemini/gemini-3.8-flash`. Snapshot reuse, forced AI failure, and retry-without-duplicates are covered by unit tests and the live database test (`netlify dev` does not replay background retries).

### Phase 3 -- Review UI -- DONE (accepted 2026-09-16)
- Board, draft editor, label and dependency pickers, approve/unapprove, delete, event history, optimistic concurrency with guarded writes, `react-markdown` preview.
- **Accept:** two browser sessions editing the same draft -> the second gets "Edited by someone else" (409); a cyclic dependency is rejected; approved drafts are read-only until unapproved; Markdown preview does not execute HTML from draft bodies (covered by a unit test).

### Phase 4 -- Posting -- DONE (accepted 2026-09-16)
- `createIssue` / `addDependency` / `listIssuesCreatedBySince` on the forge (single-attempt `createIssue`, so a timeout or 5xx cannot cause a silent double-post), `postDraft` and `reconcileDraft` (`pipeline/post.ts`, injected-store pattern like `pipeline/draft.ts`), the atomic claim and its guarded-write siblings in `db/drafts.ts`, `post-queue-background`, and editor/board actions (Post, Retry, Reconcile, "Post all ready").
- Covered by unit tests against fakes (`pipeline/post.test.ts`) and, for the raw SQL itself, by live tests against the Neon dev branch (`db/runs.live.test.ts`, "posting").
- **Accept (not yet run against a live Gitea):** the posted issue appears in Gitea authored by the posting user with the hidden marker; dependencies post first and are linked; posting a blocked draft returns 409 naming the unposted dependencies; the failure-injection test (Section 11, still not built -- needs the Docker Gitea integration environment) yields exactly one issue after reconcile.

### Phase 5 -- Production deployment -- DONE (accepted 2026-09-16)
- **Done (2026-09-14):** `netlify.toml` build config; Neon `main` database branch migrated (it is the project's default/primary branch and had never been migrated -- the Neon `dev` branch was branched off it before any schema existed); `scripts/smoke_test.py`; production Netlify site created at `https://issue-pipeline.netlify.app` (project id in `.env` as `NETLIFY_PROJECT_ID`, set up by Kayela); SPA and `/api` routing confirmed in production. Git layout is `main` = production, `dev` = ongoing work (decision 20).
- **Blocked (2026-09-14): production sign-in.** The production redirect URI is registered, but Cloudflare in front of `git.konceptkit.com` answers Netlify Functions' server-side requests with 403 (non-JSON body), so the OAuth code exchange fails (`error=failed`, log "Gitea returned 403"). Requests from a developer machine pass, which is why `netlify dev` never showed it. Every server-side Gitea call from Netlify is affected, not only OAuth. Netlify Functions have no static IPs, so the fix is a Cloudflare-side rule: find the blocking rule under Security > Events; Bot Fight Mode on the free plan cannot be bypassed by WAF rules and may need to be switched off.
- **Outstanding, owned by Kayela:** the Cloudflare rule above; confirm production environment variables on the Netlify site (Section 9 item 4); re-add `http://localhost:8888/api/auth/callback` to the Gitea OAuth app (it was removed when the production URI was added).
- **Accept:** sign-in works on the production URL; the smoke test passes against production.

Phases 6-11 add a **Settings** tab (decision 21). Settings are built and tested under `netlify dev` while production sign-in is blocked (Phase 5).

### Phase 6 -- Settings shell and per-user AI settings -- DONE (`16cfdf2`, accepted 2026-09-16)
- `CREDENTIALS_KEY` and encrypted credential columns (AES-256-GCM, AAD `"<table>:<column>:<user id>"`, previous key accepted during rotation), sharing its cipher core with the session cookie.
- Providers: Anthropic, Gemini, and an OpenAI-compatible REST client for OpenAI, xAI Grok, and Venice (fixed base URLs, `response_format: json_schema`). LM Studio stays env-only and dev-only.
- `user_ai_settings` table. The client for a run is resolved for the user who triggered it: their provider with their own key -> their provider with the team's env key -> the env provider (today's behaviour) -> an error telling them to add a key.
- `GET/PUT/DELETE /api/settings/ai` (key write-only), `GET /api/settings/ai/models?provider=`, `POST /api/settings/ai/test`.
- Web: Settings nav item, `/settings/ai` page: provider choice; picking one shows its API key field (saved keys show only the last 4 characters) and the select/draft model pickers.
- Deviations from the plan: the Test endpoint is not rate-limited yet (each click makes up to two small model calls on the caller's own key or the team's; rate limits are Phase 12 work). A retry uses the settings of whoever retries, since the job runs as the triggering user.
- **Accept:** a user with their own key for a new provider runs drafting and `runs.model_draft` names that provider; a user with no settings still uses the env provider; no key appears in any API response or log line.

### Phase 7 -- Issue templates in Settings -- DONE (`b59cb16`, accepted 2026-09-16)
- `issue_templates` (team-wide; forges it applies to; Markdown or YAML form; raw content), CRUD with optimistic `version`, server-side preview through `pipeline/templates.ts`.
- Format options by forge: Gitea and GitHub offer Markdown or a YAML issue form; GitLab and Bitbucket offer Markdown only.
- New issue modal picks "Repo's templates" (default) or an app template; the run snapshots the app template it used.
- As built: the snapshot is taken at submission (in `POST /api/raw-issues`), not when the job starts, so a retry drafts with the same template even if it was edited or deleted meanwhile. Until Phase 9 adds `repos.forge`, every tracked repo counts as Gitea (`repoForge` in `src/settings/templates.ts`), so only templates offered for Gitea appear in the New issue picker. Templates are team-wide and anyone in the org can edit or delete them, matching the approval policy (decision 8).
- **Accept:** a YAML form made in Settings drives drafting and validation on a Gitea repo; editing it later does not change old runs.

### Phase 8 -- GitHub sign-in and account linking -- DONE (`f656ab9`, accepted 2026-09-16)
- `user_identities`, plus nullable `users.gitea_id` and `user_identities.gitea_refresh_token_enc` (migrations `0004` and `0005`, both applied to the Neon `dev` branch 2026-09-14); `GET /api/auth/github/login`, `GET /api/auth/github/callback` (`src/auth/github.ts`, `src/auth/githubHandlers.ts`); link-mode added to Gitea's own `GET /api/auth/callback` (`src/auth/handlers.ts`, `linkGiteaToUser` in `src/db/users.ts`); `GET/DELETE /api/settings/connections`; `GET /api/me` moved to the new, Gitea-optional `withAccount` wrapper; the login page's GitHub button, the Settings > Connections page, and the "Connect Gitea to continue" screen (`ConnectGitea` in `Home.tsx`).
- One account, any number of linked forge identities (Gitea plus GitHub now); either Gitea or GitHub sign-in can create the account -- there is no primary forge. What is fixed: every tracked repo lives on Gitea until Phase 9, so an account with no Gitea link can sign in and see `/api/me`, but every other endpoint refuses it (`withAuth`'s `gitea_required` gate) until it connects Gitea, which the web app prompts for immediately. A second, independent allow-list (`GITHUB_ALLOWED_USERS`) gates who may sign in or link with GitHub at all, since GitHub has no equivalent of the org gate. Full design in Section 5.
- **This changed mid-build** (2026-09-15): the plan going in was GitHub-links-to-an-existing-Gitea-account only; testing it live surfaced that this forces every new person through Gitea first with no way around it, which does not match "one account, several platform sign-ins, pick whichever you have" (Kayela's framing). Extended to let either forge create the account, with Gitea's own callback gaining the same link-mode logic GitHub's already had, in the other direction.
- GitHub is identity only (`read:user` scope, a GitHub OAuth App): it does not give the app access to GitHub repos. That is Phase 9's separate GitHub App -- a Gitea-less account genuinely cannot do anything else yet, by design, until then.
- GitLab's "Sign in with GitLab" button is shown on the login page and in Connections, disabled, until Phase 10.
- **Accept:** sign in with GitHub as a brand-new account, see "Connect Gitea to continue", connect Gitea, land in the normal app as one account; separately, sign in with Gitea, link GitHub in Settings > Connections, sign out, sign in with "Sign in with GitHub" -> lands back as the same account; removing the caller from `GITEA_ALLOWED_ORG` then repeating a Gitea-backed GitHub sign-in fails with `not_member`; a GitHub username not in `GITHUB_ALLOWED_USERS` cannot link, sign in, or create an account.
- **Acceptance (2026-09-16):** sign-in, linking, and the connected GitHub account checked live by Kayela; the `not_member` and `GITHUB_ALLOWED_USERS` refusals were checked by the unit tests in `src/auth` (all passing), not live.

### Phase 9 -- GitHub repositories -- BUILT, awaiting acceptance
- `repos.forge` (`gitea` | `github`) with the unique key widened to `(forge, owner, name)`; `user_identities.access_token_enc` (migration `0006_github_repos`, Neon `dev` only).
- `GitHubForge` (`src/forge/github.ts`) implements the whole `ForgeClient`: `/user/repos` (owner, collaborator, and org-member repos, filtered by name in memory), repo, branch head, recursive tree (a truncated tree is refused with 413 rather than drafted from partially), raw files via `contents` with the raw media type, labels (repo only -- GitHub has no org labels), issue creation with label *names*, dependencies through the issue-dependencies API (`POST .../issues/{n}/dependencies/blocked_by` with the blocking issue's database `id`, checked against the docs 2026-09-15), and reconcile via `issues?creator=&since=` with pull requests dropped. Rate-limited 403s are retried like 429s; `createIssue` stays single-attempt.
- `ForgeClient` gained `label` ("Gitea"/"GitHub", for messages) and `templateDirs` (GitHub reads only `.github/ISSUE_TEMPLATE`); `CreateIssueInput.labelIds` became `labels: ForgeLabel[]` so each forge picks ids or names.
- `forgeForRepo(caller, repo)` / `repoAndForge` / `forgeForDraft` (`src/forge/forRepo.ts`): Gitea repos use the caller's session forge exactly as before; GitHub repos load the caller's sealed token by user id on the server (background jobs too -- nothing is forwarded between functions). No token -> 409 `details.reason = "not_connected"`. Every forge-using endpoint goes through it: `GET /api/github/repos` (new), `POST /api/repos` (`forge` in the body, default `gitea`), repo labels, draft label validation, post, reconcile, post queue (checked before starting the job), raw issues and run retry (checked before creating or requeueing the run), and the drafting job (fails the run with the connect message).
- GitHub sign-in now requests `read:user repo` and stores the access token on every sign-in or link when `repo` was granted (`saveGithubAccessToken`); Settings > Connections shows "no repository access yet" with Reconnect for a link made before this phase. Reconcile searches by the claimer's GitHub login for GitHub repos (`getReconcileContext` joins `user_identities`).
- Web: Repositories has a Gitea/GitHub switch for search, forge badges on tracked repos, and a link to Connections on `not_connected`; New issue labels repos with their forge and offers app templates for that forge; the draft editor says "Post to GitHub"/"Open #N in GitHub" as appropriate.
- **Deviations from the original Phase 9 plan:** an OAuth App with the broad `repo` scope instead of a GitHub App (decision 23), so there is no `forge_connections` table and no refresh/compare-and-swap (OAuth App tokens do not expire) -- the token lives on the existing `user_identities` row. The `gitea_*` draft columns and DTO fields (`gitea_number`, `gitea_url`, `linked_in_gitea`) were **not** renamed; they now hold the issue number/URL on whichever forge the repo is on. The app still needs a Gitea link to use anything (`withAuth`'s org gate, decision 22).
- **Accept:** reconnect GitHub in Settings > Connections (approving the new `repo` scope); track a private GitHub repo; draft from it (its `.github/ISSUE_TEMPLATE` form drives validation); approve and post -- the issue appears on GitHub authored by you, with dependencies linked; reconcile finds a stuck post; a teammate without a GitHub connection gets the connect message instead of an error.

### Phase 10 -- GitLab
- `GitLabForge` (gitlab.com plus optional `GITLAB_BASE_URL`), Markdown description templates, issue links for dependencies, quick-action lines neutralized in AI-written bodies.
- **Accept:** the Phase 9 flow on a GitLab project; quick-action sanitizing covered by a unit test.

### Phase 11 -- Bitbucket Cloud
- `BitbucketForge` with no labels, dependencies, or repo templates (app Markdown templates only); the UI says what is unsupported.
- **Accept:** draft and post to a Bitbucket repo with an app template.

### Phase 12 -- Hardening
- Rate limits, per-run token/cost display, audit history view, structured logging with token redaction, session and credential key rotation drill, local Gitea integration tests.
- **Accept:** security checklist in Section 10 fully ticked.

---

## 13. Decisions and VERIFY status

Resolved:

1. **Gitea reachability:** public HTTPS at `https://git.konceptkit.com`, reachable from Netlify (checked 2026-09-12).
2. **Gitea version:** 1.25.2. Checked against its `swagger.v1.json` and the v1.25.2 source:
   - The org membership, recursive tree (`recursive`/`page`/`per_page`), issue dependencies (GET/POST/DELETE), and list-issues `created_by` + `since` endpoints all exist.
   - `issue_templates` has **no `ref` parameter**, so templates are read from the tree at the snapshot sha (Section 6).
   - PKCE S256 is supported, and the fine-grained OAuth scopes (`read:user` etc.) are honoured.
   - Access tokens last 3600 s and refresh tokens 730 h by default.
3. **Allowed org:** `TrueRoster` (private: its org page returns 404 when not signed in).
4. **Neon:** dedicated project `issue-pipeline` (`mute-shadow-81137667`), `dev` branch for development.
5. **Client platform:** web app instead of Tauri (2026-09-12). This removes installers, the updater, code signing, and the MSVC toolchain requirement.
6. **Gitea OAuth app:** confidential, with `http://localhost:8888/api/auth/callback` registered (2026-09-12). The production URI is added in Phase 5.
7. **Posting identity:** issues are authored by the posting user (default taken).
8. **Approval policy:** a user may approve their own drafts, recorded in `approved_by` (default taken).
9. **Background Functions:** available on the current Netlify plan (Kayela, 2026-09-12).
10. **AI provider (2026-09-12/13):** selected by `.env` / Netlify env var, not the UI. Gemini (Google AI Studio key) is used now; Anthropic once an API key is available; LM Studio for local testing only (a 7B model at 8K context is too small for real repos, and larger models do not fit the development machine). Venice was evaluated and not used: it offers only an OpenAI-compatible API, with no Anthropic-style `/messages` endpoint.
11. **Structured output:** Anthropic structured outputs rather than forced tool calls (keeps working on models that reject forced `tool_choice`); Gemini `responseJsonSchema` (field confirmed against the live API); forced tool calls only for LM Studio.
12. **Repository conventions (2026-09-13):** every tracked repository carries `README.md` and `ROUTING.md` at its root. `ROUTING.md` maps areas of the system to paths (e.g. `- Password reset: app/Http/Controllers/Auth/, routes/web.php`).
13. **Dependencies approved:** `yaml` (2026-09-12), `react-markdown` (2026-09-13). `remark-gfm` not requested.
14. **Queue and run detail (2026-09-13):** runs expand inside the Queue tab instead of a separate page; submitting notes lands on the Queue.
15. **Posting reason codes (2026-09-13):** `POST /api/drafts/:id/post` and `/reconcile` use their own `details.reason` values (`unposted_deps`, `claimed`, `not_stale`) rather than being forced into the edit endpoints' `status` | `stale` pair, since the ways a claim or a reconcile can be refused genuinely differ from a stale edit.
16. **Retry logs no new event (2026-09-13):** `failed -> approved` via `POST /api/drafts/:id/retry` does not add a `draft_events` row. The existing `claimed` -> `failed` history already shows what happened; none of the ten documented event names (Section 4) fit "retried" without being reused in a way that would misread as a fresh human decision.
17. **`post-queue-background` never throws for a platform retry (2026-09-13):** unlike `draft-run-background`, each draft it posts is claimed atomically, so a lost race just moves on to the next ready draft. Retrying the whole batch on a platform retry would only redo work the loop's own stop conditions already bound.
18. **Neon production database branch is `main` (2026-09-14):** the project's default/primary branch, not a separately created one. It had never been migrated (the Neon `dev` branch was branched off it right after project creation, before any schema existed), so `pnpm db:migrate` was run against it directly.
19. **`SECRETS_SCAN_OMIT_KEYS` added to `netlify.toml` (2026-09-14):** the first production deploy failed Netlify's secrets scan. It flags every env var configured on the site and fails the build if that literal value appears anywhere in the repo or build output; `GITEA_BASE_URL`, `GITEA_ALLOWED_ORG`, and `NODE_ENV` are legitimately non-secret and their values (an org name, a host, a build mode) collide with ordinary text throughout the code, tests, and this doc. `MODEL_SELECT` and `MODEL_DRAFT` were also flagged -- these are not env vars the app reads at all (see Section 5: the app reads `ANTHROPIC_MODEL_SELECT`/`ANTHROPIC_MODEL_DRAFT` or `GEMINI_MODEL_SELECT`/`GEMINI_MODEL_DRAFT`, prefixed by provider), so they were added to the omit list rather than chased down as real config. Real secrets (API keys, `SESSION_SECRET`, `DATABASE_URL`, `GITEA_OAUTH_CLIENT_SECRET`, `INTERNAL_JOB_SECRET`) are untouched and stay scanned.
20. **Git branch layout settled as `main` (production) + `dev` (ongoing work), no `prod` branch (2026-09-14):** same-day back-and-forth. First, Netlify's production branch was set to a new `prod` branch, and git's `main` was renamed to `dev` to match (pushed as `origin/dev`; `origin/main` was left behind, briefly stale). Kayela then deleted `prod` and decided to keep the conventional `main` = production / `dev` = ongoing-work split instead. Net effect: git `main` still exists and is production again; git `dev` also exists (it carries the same history, since it was the renamed `main`) and is where ongoing work happens; `origin/prod` should be deleted if it still exists. GitHub's repository default-branch setting was never changed from `main` (the agent has no `gh` CLI or API access, so this would have been a manual step regardless), which conveniently matches the final decision. Git's `dev` branch is unrelated to the Neon *database* branch also called `dev` (item 2 above) -- same name, different systems, worth double-checking against in any future instruction that just says "dev."

21. **Settings tab (2026-09-14):** Kayela asked for a Settings tab with per-user AI provider/model/key selection (Anthropic, Gemini, Grok, OpenAI, Venice), connections to GitHub, GitLab, and Bitbucket in addition to Gitea, and issue templates managed in the app. Choices: AI settings are per user with the env-var setup as the team fallback; Gitea sign-in and the org gate remain the only way to *create* an account (superseded for GitHub specifically by decision 22); other forges are OAuth "Connect" connections used for repo reads and posting; templates live in the database and a repo's own templates stay the default. This reverses rule 0.5 (credentials may now be stored, encrypted) and two v1 non-goals (Section 1). Venice (decision 10) is now supported through the OpenAI-compatible client. Built as Phases 6-11; hardening moves to Phase 12.
22. **GitHub sign-in and account linking (2026-09-14/15):** Kayela asked for GitHub (and later GitLab) as real sign-in options on the login page, not just Phase 9's repo-access "Connect". First round: the access gate is a separate allow-list, `GITHUB_ALLOWED_USERS` (not a GitHub org/team, since TrueRoster's equivalent does not exist on GitHub); since every tracked repo lives on Gitea until Phase 9, the app still mints a real Gitea session under a GitHub sign-in by storing (encrypted) a snapshot of the linked account's Gitea refresh token at link time, rather than bouncing the browser through a second, visible Gitea prompt on every GitHub sign-in -- a new category of stored secret (a live Gitea credential, not just a third-party API key), chosen explicitly over the token-free alternative for a true one-click sign-in. Built and tested against a live Gitea/GitHub locally 2026-09-15 as "GitHub links to an existing Gitea account, Gitea always comes first" -- Kayela's reaction: "why can't GitHub sign up like Gitea does? What if a user does not have Gitea?" **Revised same day:** one account, several forge identities, and *either* Gitea or GitHub can create the account -- there is no primary forge, matching "one user, multiple platform accounts, log in with whichever." An account with no Gitea link can still sign in and see `/api/me`, but every other endpoint needs Gitea (nothing else exists yet, forge-wise), so the app prompts it to connect Gitea instead of showing an empty app. This meant relaxing `users.gitea_id` and `user_identities.gitea_refresh_token_enc` to nullable, and Gitea's own OAuth callback gaining the reverse link-mode logic. Full design in Section 5. Built as Phase 8; GitLab's button is shown disabled until Phase 10.
23. **GitHub repository access through the OAuth App (2026-09-15):** Kayela asked for the Repositories page to show her GitHub repos, and chose the full pipeline (track, draft, post) rather than listing only. Offered a least-privilege GitHub App (Issues write, Contents read, Metadata, granted per repo, expiring tokens -- the original Phase 9 plan) or reusing the Phase 8 OAuth App with the `repo` scope, she chose the OAuth App: no second app to create, and tokens that never expire. The cost, stated when choosing: `repo` is full read/write to every repository the user can reach, including code, and an org owner may need to approve the app for org repos. Tokens are sealed under `CREDENTIALS_KEY` like every other stored credential (rule 0.5). Built as Phase 9.

Still to verify or decide before the phase that depends on them:

| Item | Needed by | Status |
|---|---|---|
| `[oauth2] INVALIDATE_REFRESH_TOKENS` is `false` on the instance | Phase 1 | Not explicitly confirmed; the default `false` is assumed. If `true`, parallel refreshes revoke the grant and refresh must be serialized |
| `/api/*` functions take precedence over the JSON-404 redirect | Phase 5 | **Failed in production (2026-09-14):** the first live deploy answered every `/api/*` route with the JSON 404, because that redirect was `force = true` and a forced rule shadows functions with a `config.path` (under `netlify dev` the functions still won). `force` removed. **Confirmed fixed in production (2026-09-14):** `/api/health` 200 with `db: ok`, `/api/me` 401 from `withAuth`, an unknown `/api` path gets the JSON 404 |
| Gitea OAuth redirect URI registered for `https://issue-pipeline.netlify.app` | Phase 5 | Outstanding -- Kayela's own Gitea admin access |
| Netlify's production branch setting is `main` (not still `prod`) | Phase 5 | Outstanding -- Kayela needs to flip this back in the Netlify dashboard; not done by the agent (no Netlify access) |
| `origin/prod` deleted | Phase 5 | Outstanding -- confirm it's gone from GitHub, not just deleted locally |
| Production env vars match what the app reads | Phase 5 | The Netlify site also has `VENICE_API_KEY`/`VENICE_BASE_URL` set (Venice is not a supported `LLM_PROVIDER`, decision 10) and `LLM_PROVIDER` itself is not set (defaults to `anthropic`, which has its key set, so this is not blocking) -- worth cleaning up but not confirmed broken |
| Issue dependencies enabled on each target repo | Phase 4 acceptance | Outstanding -- not verified against a real Gitea in this session |
| Dependency links inside the template's "Dependencies / blockers" section vs. an appended line | Future | Open; Phase 4 shipped with the simple appended `**Depends on:**` line |
| Whether to add `remark-gfm` so checklists and tables render in the preview | Phase 3 follow-up | Open |
| Cloudflare lets Netlify Functions reach `git.konceptkit.com` | Phase 5 | **Blocking production sign-in** -- see Phase 5 |
| OpenAI, xAI, and Venice accept `response_format: json_schema` on chat completions | Phase 6 | Docs checked 2026-09-14: all three document it (xAI labels chat completions "legacy" but still serves it; Venice support can vary by model). Token cap parameter: `max_completion_tokens` for OpenAI and Venice, `max_tokens` for xAI. Still to confirm with a live call per provider |
| GitHub issue-dependency REST API; GitLab `blocks` link tier; Bitbucket Cloud issues API still offered | Phases 8-10 | Open |
