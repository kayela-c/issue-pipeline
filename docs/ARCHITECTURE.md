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
5. A Gitea token or API key must never be logged, stored in Postgres, placed in a URL, or made readable by browser JavaScript. The only place a user's Gitea token exists at rest is inside the encrypted, `HttpOnly` session cookie (Section 5).
6. Keep this file ASCII-only.

---

## 1. Purpose

A web app for a small team that turns rough issue notes into well-formed Gitea issues.

**Stage 1 -- Drafting (AI).** A user submits raw issue text against a repo. The system reads the repo through the Gitea API (guided by the repo's `README.md` and `ROUTING.md`), and an AI produces one or more issue drafts that follow the repo's Gitea issue template, including dependencies between the drafts. Drafts land in the database for human review.

**Stage 2 -- Posting (no AI).** A teammate approves drafts. An approved draft whose dependencies are all posted is claimed atomically, created in Gitea under the posting user's account, linked to its dependencies, and marked `posted` with its issue number. This stage is deterministic code only.

**Non-goals for v1:** native desktop app, offline mode, GitHub support (keep the adapter seam, implement Gitea only), syncing edits back from Gitea after posting, auto-posting without approval, Excel import/export, cross-repo dependencies, sign-in on Netlify deploy previews, choosing the AI provider from the UI.

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
                                         (LLM_PROVIDER: gemini | anthropic | lmstudio)
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
| AI usage | Two narrow calls in Stage 1 only, provider chosen by env var | Posting stays predictable and cheap; the team can switch providers without code changes |
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
|   |   |   +-- routes/               # Login, Home (nav), NewIssue, Queue, RunView, Board, DraftEditor, Repos
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
|       |   +-- llm/index.ts          # provider selection from env, error description/classification
|       |   +-- llm/anthropic.ts      # Anthropic SDK client (Anthropic API, or LM Studio's endpoint)
|       |   +-- llm/gemini.ts         # Gemini REST client
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

Defined in Drizzle (`apps/api/src/db/schema.ts`); migrations are generated with `drizzle-kit` and applied with `pnpm db:migrate`. Applied so far: `0000_init`, `0001_snapshot_routing` (adds `repo_snapshots.routing` and clears cached snapshots). Statuses use `text` + `CHECK` rather than enums so they are easy to extend.

There is deliberately **no sessions table**: session state lives in the encrypted cookie (Section 5).

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gitea_id      bigint UNIQUE NOT NULL,
  username      text NOT NULL,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner           text NOT NULL,
  name            text NOT NULL,
  default_branch  text NOT NULL,
  added_by        uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
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
| `LLM_PROVIDER` | `gemini`, `anthropic` (default when unset), or `lmstudio` (local development only; refuses to run when deployed). Selected by env var only: keys never pass through the UI. Switching is one line plus a restart or redeploy |
| `GOOGLE_API_KEY`, `GEMINI_MODEL_SELECT`, `GEMINI_MODEL_DRAFT` | Gemini API key (Google AI Studio, with credits) and models; default `gemini-3.5-flash-lite` / `gemini-3.8-flash` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_SELECT`, `ANTHROPIC_MODEL_DRAFT` | Anthropic API key and models; default `claude-haiku-4-5-20251001` / `claude-sonnet-5` |
| `LMSTUDIO_BASE_URL`, `LMSTUDIO_API_KEY`, `LMSTUDIO_MODEL_SELECT`, `LMSTUDIO_MODEL_DRAFT`, `LMSTUDIO_CONTEXT_TOKENS`, `LMSTUDIO_MAX_OUTPUT_TOKENS` | LM Studio 0.4.1+ (default `http://localhost:1234`). Model ids are required; the context length is the one the model is loaded with, and prompts are sized to fit it |
| `LLM_MAX_OUTPUT_TOKENS` | Optional drafting output cap for any provider |
| `GITEA_BASE_URL` | e.g. `https://git.konceptkit.com` |
| `GITEA_ALLOWED_ORG` | Org short name; only its members may use the app |
| `GITEA_OAUTH_CLIENT_ID` | Gitea OAuth2 application (confidential) |
| `GITEA_OAUTH_CLIENT_SECRET` | Its client secret. Server-side only |
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

- Each auth route is its own function file: for cross-origin requests `netlify dev` retries the path with `/index.html` appended, which breaks routing on `pathname` inside one function.
- `redirect_uri` is `{request origin}/api/auth/callback`. Confidential clients get an **exact** redirect match in Gitea, so each origin must be registered on the OAuth app: the production URL and `http://localhost:8888` (not `127.0.0.1`). Deploy previews are not registered, so sign-in does not work there (non-goal).
- **Scopes:** `read:user read:organization read:repository write:issue`. Gitea 1.25 silently widens a token to *all* scopes if any requested name is invalid, so the scope string is a constant with a unit test.

### Auth wrapper -- `withAuth(handler)`

Accepts **either** the session cookie (browsers) **or** `Authorization: Bearer <Gitea token>` (Python scripts, integration tests, and background jobs). A bearer token is not an ambient credential, so bearer requests skip the CSRF check and never receive `Set-Cookie`.

1. **CSRF (cookie requests only).** For any method other than GET/HEAD/OPTIONS, require an `Origin` header equal to the request's own origin, `Sec-Fetch-Site` (when sent) of `same-origin`, and `Content-Type: application/json` when there is a body. Otherwise 403.
2. **Credentials.** Decrypt the session cookie, or read the bearer token. Missing, undecryptable, or past `SESSION_MAX_AGE_DAYS` -> 401 (and clear the cookie).
3. **Refresh (cookie requests only).** If `access_expires_at` is within **20 minutes**, POST `grant_type=refresh_token` with `client_id` + `client_secret`. On success, store the rotated tokens and re-issue the cookie on the response. If Gitea rejects the refresh token -> 401 and clear the cookie. On a network error or Gitea 5xx -> 502, keeping the cookie. The 20-minute margin guarantees any token forwarded to a background job outlives its 15-minute limit.
4. `GET {GITEA_BASE_URL}/api/v1/user` with the token; 401/403 -> 401. For cookie requests, the returned id must equal the session's `gitea_id`.
5. `GET /api/v1/orgs/{GITEA_ALLOWED_ORG}/members/{username}` without following redirects; only a direct 204 counts as membership, otherwise 403.
6. Upsert `users` by `gitea_id`, update `last_seen_at`.
7. Call `handler(req, { user, giteaToken, forge }, context)`, where `forge` is a `GiteaForge` bound to the token.

Tokens are held in memory for the request only. Log paths and statuses, never headers or cookies, and scrub the token from any logged error text.

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
6. **Draft** (`status = 'drafting'`, the provider's draft model). Input: raw issue, repo name, `ROUTING.md`, selected file contents, template descriptions (for forms: each section, required or optional, exact dropdown options), label names. Output:

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

Both calls go through one `LlmClient` interface; the provider is chosen by `LLM_PROVIDER`.

| Provider | Transport | JSON output | Notes |
|---|---|---|---|
| `gemini` | REST `models/{model}:generateContent` with `x-goog-api-key` | `generationConfig.responseJsonSchema` (from the zod schema) | Thought parts ignored; the model turn (with thought signatures) replayed verbatim for the repair call. The client retries 503 "high demand", rate-limit 429s, and network errors up to 4 attempts (~2 s, 4 s, 8 s backoff). Depleted prepaid credits (429) are not retried and get a message pointing to AI Studio |
| `anthropic` | `@anthropic-ai/sdk`, streamed | Structured outputs (`output_config.format`) | Top-level prompt caching so the repair turn re-reads the repository context cheaply. SDK retries transient errors |
| `lmstudio` | `@anthropic-ai/sdk` pointed at LM Studio's Anthropic-compatible `/v1/messages` | Forced tool call (`tool_choice: any`) with a JSON schema | Local development only. No caching. Prompt budgeting applies (below) |

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

- "Sign in with Gitea" is a plain navigation to `/api/auth/login?return_to=...` (not `fetch`), so the whole OAuth flow is top-level redirects.
- `/login?error=` (`denied`, `not_member`, `expired`, `failed`, `unavailable`) renders an explanatory message.
- On load, `GET /api/me` decides between the signed-in app and the sign-in screen.

### Screens

| Screen | Path | Contents |
|---|---|---|
| Sign in | `/login` | "Sign in with Gitea" button; error states |
| New issue | `/` | Repo select + notes text area -> submit -> lands on the Queue with the new run expanded |
| Queue | `/queue`, `/queue/<run id>` | Every run, in-progress first, then recent: status pill, repo, author, time, notes excerpt, error, draft counts by status. Clicking a row expands its progress steps, commit, model, tokens, notes, retry (when failed), and drafts (rendered Markdown, linked to the editor). Old `/runs/<id>` links redirect here |
| Board | `/board?repo=<id>` | Columns by status: Draft, Approved, Posting, Posted, Failed; repo filter (or all repos). Cards: title, repo, labels, "Blocked by N unposted drafts", issue number, approver |
| Draft editor | `/drafts/<id>` | Status, repo, template, author, approver, Gitea link. While `draft`: title, body with Write / Preview tabs, label chips (repo labels live from Gitea), dependency checkboxes (same-repo drafts with their status), Save, Approve (disabled while there are unsaved changes), Delete with inline confirm. While `approved`: read-only view with Unapprove. "Needed by" list and event history. A stale save or approval shows **"Edited by someone else"** with Reload; the editor also polls every 15 s and flags a newer version if the form has unsaved edits |
| Repositories | `/repos` | Tracked repos; search accessible repos and track one (disabled for archived repos or repos with issues turned off) |
| Card actions | built | Post and Unapprove on `approved` drafts, Retry on `failed`, Reconcile on `posting` (all in the draft editor); "Post all ready" on the board, scoped to the selected repo |

**Markdown renders AI-written text, so it must not render raw HTML.** `components/Markdown.tsx` uses `react-markdown` with `skipHtml` and its default URL filter, and opens links in a new tab with `rel="noopener noreferrer"`. A test asserts script tags, event handlers, and `javascript:` links never reach the page. GitHub-flavoured extras (task-list checkboxes, tables) would need `remark-gfm`, not added; `- [ ]` checklists currently render as plain text in the preview.

### Security headers

- `netlify.toml` headers on every path: `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (the OAuth callback overrides with `no-referrer`).
- The production build adds a CSP `<meta>` tag: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`. It is not applied in development because Vite's dev server needs inline scripts, and `frame-ancestors` cannot be set from a meta tag.
- API responses send `Cache-Control: no-store`.

---

## 9. Deployment -- Phase 5

1. **One Netlify site** built from `main`: build command compiles `packages/shared` and `apps/web`; `publish = apps/web/dist`; `functions = apps/api/netlify/functions`. No base directory. `netlify.toml` at the repo root already has this -- **done**.
2. **Environments:** production uses the Neon project's `main` branch (its default/primary branch); local dev (`netlify dev`) uses the `dev` branch. Migrations are applied with `pnpm db:migrate` before a deploy that needs them. **Done (2026-09-14):** `main` had zero tables (only `dev` had ever been migrated); `pnpm db:migrate` was run against it and all 8 tables plus `drizzle.__drizzle_migrations` now exist.
3. **Gitea OAuth app:** confidential client with redirect URIs `https://<production-site>/api/auth/callback` and `http://localhost:8888/api/auth/callback`. **Outstanding** -- needs the production site's URL first (see below), then an admin adds it in Gitea.
4. **Secrets** (`GITEA_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY`, `DATABASE_URL`, `INTERNAL_JOB_SECRET`) live only in Netlify environment variables and the local, gitignored `.env`. Use different `SESSION_SECRET` values per environment. **Outstanding** -- Netlify site creation and env vars are done from the Netlify dashboard/CLI with Kayela's own login, not by the agent.
5. **AI provider:** `LLM_PROVIDER` must be `gemini` or `anthropic` in production; `lmstudio` refuses to run outside `netlify dev`.
6. **Key rotation:** set the new key as `SESSION_SECRET` and the old one as `SESSION_SECRET_PREVIOUS`; remove the old key after `SESSION_MAX_AGE_DAYS`.
7. **Deploy previews** build and serve the UI and `/api/health`, but sign-in is unsupported there (their URLs are not registered redirect URIs).
8. **Smoke test:** `scripts/smoke_test.py` (Python, `requests`) runs the full path -- track a repo, submit notes, wait for drafting, approve, post -- against a deployed site using a bearer PAT (`pip install -r scripts/requirements.txt`, then see the script's docstring for usage). **Built, not yet run against a live deployment** (there is no production site to point it at yet).

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
- [ ] AI provider keys server-side only; provider chosen by env var, never from the UI.
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

### Phase 3 -- Review UI -- BUILT, awaiting acceptance (uncommitted)
- Board, draft editor, label and dependency pickers, approve/unapprove, delete, event history, optimistic concurrency with guarded writes, `react-markdown` preview.
- **Accept:** two browser sessions editing the same draft -> the second gets "Edited by someone else" (409); a cyclic dependency is rejected; approved drafts are read-only until unapproved; Markdown preview does not execute HTML from draft bodies (covered by a unit test).

### Phase 4 -- Posting -- BUILT, awaiting acceptance (uncommitted)
- `createIssue` / `addDependency` / `listIssuesCreatedBySince` on the forge (single-attempt `createIssue`, so a timeout or 5xx cannot cause a silent double-post), `postDraft` and `reconcileDraft` (`pipeline/post.ts`, injected-store pattern like `pipeline/draft.ts`), the atomic claim and its guarded-write siblings in `db/drafts.ts`, `post-queue-background`, and editor/board actions (Post, Retry, Reconcile, "Post all ready").
- Covered by unit tests against fakes (`pipeline/post.test.ts`) and, for the raw SQL itself, by live tests against the Neon dev branch (`db/runs.live.test.ts`, "posting").
- **Accept (not yet run against a live Gitea):** the posted issue appears in Gitea authored by the posting user with the hidden marker; dependencies post first and are linked; posting a blocked draft returns 409 naming the unposted dependencies; the failure-injection test (Section 11, still not built -- needs the Docker Gitea integration environment) yields exactly one issue after reconcile.

### Phase 5 -- Production deployment -- PARTIALLY DONE
- **Done (2026-09-14):** `netlify.toml` build config; Neon `main` branch migrated (it is the project's default/primary branch and had never been migrated -- `dev` was branched off it before any schema existed); `scripts/smoke_test.py`.
- **Outstanding, owned by Kayela** (Netlify account and Gitea admin access, not the agent's): create the production Netlify site from `main`, set its environment variables (Section 9 item 4), register the production redirect URI on the Gitea OAuth app once the site URL exists.
- **Accept:** sign-in works on the production URL; the smoke test passes against production.

### Phase 6 -- Hardening
- Rate limits, per-run token/cost display, audit history view, structured logging with token redaction, session key rotation drill, local Gitea integration tests.
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
18. **Neon production branch is `main` (2026-09-14):** the project's default/primary branch, not a separately created one. It had never been migrated (`dev` was branched off it right after project creation, before any schema existed), so `pnpm db:migrate` was run against it directly.

Still to verify or decide before the phase that depends on them:

| Item | Needed by | Status |
|---|---|---|
| `[oauth2] INVALIDATE_REFRESH_TOKENS` is `false` on the instance | Phase 1 | Not explicitly confirmed; the default `false` is assumed. If `true`, parallel refreshes revoke the grant and refresh must be serialized |
| `/api/*` functions take precedence over the SPA fallback redirect | Phase 5 | Confirmed under `netlify dev`; re-check once a production site exists |
| Production Netlify site created, env vars set, Gitea OAuth redirect URI registered | Phase 5 | Outstanding -- Kayela's own accounts, not done by the agent |
| Issue dependencies enabled on each target repo | Phase 4 acceptance | Outstanding -- not verified against a real Gitea in this session |
| Dependency links inside the template's "Dependencies / blockers" section vs. an appended line | Future | Open; Phase 4 shipped with the simple appended `**Depends on:**` line |
| Whether to add `remark-gfm` so checklists and tables render in the preview | Phase 3 follow-up | Open |
