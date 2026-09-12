# Issue Pipeline -- Architecture Plan

> Handoff document for Claude Code. Working name: `issue-pipeline`.
> Revised 2026-09-12: the client is a **web app** (React SPA on the Netlify site), replacing the original Tauri desktop app.

## 0. Instructions for Claude Code

1. Build **one phase at a time** (Section 12). Stop at the end of each phase, summarize what was built, and list anything that deviated from this plan.
2. Items marked **VERIFY** must be checked against the real Gitea instance, Netlify plan, or current docs before the code depends on them. If a VERIFY item turns out false, stop and report instead of improvising a workaround.
3. Do not add dependencies beyond those listed without flagging them first. No LangChain or agent frameworks; AI calls go straight through `@anthropic-ai/sdk`.
4. Standalone utility scripts (seeding, smoke tests, maintenance) are written in **Python**. Application code is TypeScript (API and UI).
5. A Gitea token or API key must never be logged, stored in Postgres, placed in a URL, or made readable by browser JavaScript. The only place a user's Gitea token exists at rest is inside the encrypted, `HttpOnly` session cookie (Section 5).

---

## 1. Purpose

A web app for a small team that turns rough issue notes into well-formed Gitea issues.

**Stage 1 -- Drafting (AI).** A user submits raw issue text against a repo. The system reads the repo through the Gitea API, and an AI produces one or more issue drafts that follow the repo's Gitea issue template, including dependencies between the drafts. Drafts land in the database for human review.

**Stage 2 -- Posting (no AI).** A teammate approves drafts. An approved draft whose dependencies are all posted is claimed atomically, created in Gitea under the posting user's account, linked to its dependencies, and marked `posted` with its issue number. This stage is deterministic code only.

**Non-goals for v1:** native desktop app, offline mode, GitHub support (keep the adapter seam, implement Gitea only), syncing edits back from Gitea after posting, auto-posting without approval, Excel import/export, cross-repo dependencies, sign-in on Netlify deploy previews.

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
                                    +-- Anthropic API    Stage 1 drafting only
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
| AI usage | Two narrow calls in Stage 1 only | Posting stays predictable and cheap |
| Forge access | `ForgeClient` interface, Gitea implementation | Keeps GitHub possible later without a rewrite |
| Realtime | Polling (2 s while a run is active) | Functions are stateless; no websockets needed |

---

## 3. Repository layout

pnpm workspaces monorepo. One Netlify site: `publish` is the SPA build, `functions` is the API.

```
issue-pipeline/
+-- apps/
|   +-- web/                         # Vite + React + TypeScript SPA
|   |   +-- src/
|   |   |   +-- lib/api.ts           # typed fetch wrapper (same-origin, JSON)
|   |   |   +-- lib/auth.ts          # session hooks (useMe, login redirect, logout)
|   |   |   +-- routes/              # Login, Repos, NewIssue, Board, DraftEditor
|   |   |   +-- components/
|   |   +-- index.html
|   |   +-- vite.config.ts
|   +-- api/
|       +-- netlify/functions/       # one file per endpoint group (one per auth route) + 2 background fns
|       +-- src/
|       |   +-- db/schema.ts         # Drizzle schema (matches Section 4)
|       |   +-- db/client.ts         # neon-http + drizzle
|       |   +-- auth/session.ts      # cookie encrypt/decrypt, cookie attributes
|       |   +-- auth/oauth.ts        # authorize URL, code exchange, refresh (Gitea)
|       |   +-- auth/csrf.ts         # Origin / Sec-Fetch-Site / JSON content-type check
|       |   +-- auth/handlers.ts     # login, callback, logout
|       |   +-- auth/withAuth.ts     # session-or-bearer wrapper, refresh, org gate
|       |   +-- forge/types.ts       # ForgeClient interface
|       |   +-- forge/gitea.ts       # Gitea implementation
|       |   +-- llm/anthropic.ts     # thin SDK wrapper, tool-use JSON output
|       |   +-- pipeline/draft.ts    # Stage 1
|       |   +-- pipeline/post.ts     # Stage 2
|       |   +-- pipeline/graph.ts    # cycle detection, topo helpers
|       +-- prompts/                 # versioned prompts as TS string modules
|       +-- drizzle/                 # generated migrations
|       +-- drizzle.config.ts
+-- packages/
|   +-- shared/                      # zod schemas + inferred TS types (API contract)
+-- scripts/                         # Python utilities (seed_gitea.py, smoke_test.py)
+-- docs/ARCHITECTURE.md             # this file
+-- netlify.toml                     # at the repo root (see README "Gotchas")
+-- pnpm-workspace.yaml
```

**Local dev:** `netlify dev` runs the Vite dev server as its framework (`[dev] command` + `targetPort`) and serves functions on the same origin, `http://localhost:8888`. Cookies, OAuth redirects, and the CSRF origin check therefore behave as in production.

**SPA routing:** `netlify.toml` adds a `/* -> /index.html 200` fallback, preceded by a forced `/api/* -> /api-not-found.json 404` rule so unknown API paths return JSON rather than the SPA shell. Functions with a `config.path` take precedence over both rules (confirmed under `netlify dev`; re-check on the first production deploy).

---

## 4. Data model (Neon Postgres)

Defined in Drizzle (`apps/api/src/db/schema.ts`); the migration is generated with `drizzle-kit` and the generated SQL is confirmed against the DDL below. Statuses use `text` + `CHECK` rather than enums so they are easy to extend.

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
  model_select    text,
  model_draft     text,
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

- Title, body, labels, and deps can be edited only while `status = 'draft'`. Every edit requires the client's `version`; a mismatch returns **409** and the edit increments `version`.
- A draft's dependencies can be changed only while that draft is in `draft` status. Targets must be drafts in the same repo (any status; an already-posted target simply counts as satisfied), and the change must not create a cycle (DFS in `pipeline/graph.ts`).
- Only `draft` drafts can be deleted.

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

**Stack:** Netlify Functions v2 (`export default async (req, context)` with `export const config = { path }`), Drizzle ORM over `@neondatabase/serverless` (HTTP driver), `zod` for every request and AI output, `@anthropic-ai/sdk`. Session encryption uses `node:crypto` (no extra dependency). No web framework. Use single statements where possible and `db.batch([...])` for multi-statement atomic writes.

### Environment variables (Netlify)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `ANTHROPIC_API_KEY` | Stage 1 only |
| `MODEL_SELECT` | File-selection model, default `claude-haiku-4-5-20251001` |
| `MODEL_DRAFT` | Drafting model, default `claude-sonnet-5` |
| `GITEA_BASE_URL` | e.g. `https://git.konceptkit.com` |
| `GITEA_ALLOWED_ORG` | Org short name; only its members may use the app |
| `GITEA_OAUTH_CLIENT_ID` | Gitea OAuth2 application (confidential) |
| `GITEA_OAUTH_CLIENT_SECRET` | Its client secret. Server-side only |
| `SESSION_SECRET` | 32 random bytes, base64. Encrypts session and login-state cookies |
| `SESSION_SECRET_PREVIOUS` | Optional. Old key accepted for decryption during rotation |
| `SESSION_MAX_AGE_DAYS` | Absolute session lifetime, default `7` |
| `INTERNAL_JOB_SECRET` | Shared secret for background-function calls |
| `MAX_RUNS_PER_USER_PER_DAY` | Cost guard, default `50` |

Model ids stay env-configurable so they can be rolled without a deploy. Nothing is exposed to the SPA bundle: the web app needs no build-time configuration, because everything it talks to is same-origin.

### Sessions

Two cookies, both encrypted with AES-256-GCM under `SESSION_SECRET`. Each ciphertext carries a key-version byte (for rotation) and uses the cookie name as additional authenticated data, so one cookie can never be replayed as the other.

| Cookie | Contents | Attributes |
|---|---|---|
| `__Host-ip_session` | `{ v, uid, gitea_id, username, access_token, refresh_token, access_expires_at, session_started_at }` | `HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age` = time left of `SESSION_MAX_AGE_DAYS` |
| `__Host-ip_oauth` | `{ state, code_verifier, return_to }` | `HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age=600`; deleted at callback |

- `SameSite=Lax` is required: the OAuth callback is a top-level navigation arriving from Gitea, and it must carry the login-state cookie.
- Browsers accept `Secure` cookies on `http://localhost`, so the `__Host-` names work under `netlify dev`.
- The session cookie must stay under 4 KB; a unit test asserts this with realistic token sizes.
- **Revocation:** logging out deletes the cookie. A copied cookie stays usable until `SESSION_MAX_AGE_DAYS` elapses, **or** until the user (or a Gitea admin) revokes the app's grant in Gitea. Gitea validates OAuth access tokens against the grant, so revocation takes effect on the next request.

### Auth endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/auth/login?return_to=` | Generate `state` and PKCE `code_verifier` / S256 `code_challenge`; set `__Host-ip_oauth`; 302 to `{GITEA}/login/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`. `return_to` must be a relative path (starts with `/`, not `//`); anything else becomes `/`. |
| GET | `/api/auth/callback` | Require `__Host-ip_oauth` and a matching `state`; on Gitea `error`, 302 to `/login?error=denied`. Exchange the code at `{GITEA}/login/oauth/access_token` with `client_id`, `client_secret`, `code_verifier`, `redirect_uri`. `GET /api/v1/user`, then the org membership check: a non-member gets **no session** and a 302 to `/login?error=not_member`. Otherwise upsert `users`, set `__Host-ip_session`, delete `__Host-ip_oauth`, and 302 to `return_to`. Send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. |
| POST | `/api/auth/logout` | CSRF check; delete the session cookie; 204. |

- `redirect_uri` is `{request origin}/api/auth/callback`. Confidential clients get an **exact** redirect match in Gitea, so each origin must be registered on the OAuth app: the production URL and `http://localhost:8888`. Deploy previews are not registered, so sign-in does not work there (non-goal).
- **Scopes:** `read:user read:organization read:repository write:issue`. Gitea 1.25 silently widens a token to *all* scopes if any requested name is invalid, so the scope string is a constant with a unit test.

### Auth wrapper -- `withAuth(handler)`

Accepts **either** the session cookie (browsers) **or** `Authorization: Bearer <Gitea token>` (Python scripts, integration tests, and background jobs). A bearer token is not an ambient credential, so bearer requests skip the CSRF check and never receive `Set-Cookie`.

1. **CSRF (cookie requests only).** For any method other than GET/HEAD, require an `Origin` header equal to the request's own origin, and `Content-Type: application/json` when there is a body. Otherwise 403.
2. **Credentials.** Decrypt the session cookie, or read the bearer token. Missing, undecryptable, or past `SESSION_MAX_AGE_DAYS` -> 401 (and clear the cookie).
3. **Refresh (cookie requests only).** If `access_expires_at` is within **20 minutes**, POST `grant_type=refresh_token` with `client_id` + `client_secret`. On success, store the rotated tokens and re-issue the cookie on the response. If Gitea rejects the refresh token -> 401 and clear the cookie. On a network error or Gitea 5xx -> 502, keeping the cookie. The 20-minute margin guarantees any token forwarded to a background job outlives its 15-minute limit.
4. `GET {GITEA_BASE_URL}/api/v1/user` with the token; non-200 -> 401. For cookie requests, the returned id must equal the session's `gitea_id`.
5. `GET /api/v1/orgs/{GITEA_ALLOWED_ORG}/members/{username}` without following redirects; only a direct 204 counts as membership, otherwise 403.
6. Upsert `users` by `gitea_id`, update `last_seen_at`.
7. Call `handler(req, { user, giteaToken, forge })`, where `forge` is a `GiteaForge` bound to the token.

Tokens are held in memory for the request only. Log paths and statuses, never headers or cookies, and scrub the token from any logged error text.

**VERIFY:** the Gitea `[oauth2] INVALIDATE_REFRESH_TOKENS` setting. It defaults to `false`. If it is `true`, two parallel requests refreshing with the same refresh token make Gitea revoke the whole grant; refresh would then need to be serialized, e.g. a single client-side refresh call.

### `ForgeClient` interface (`src/forge/types.ts`)

```ts
interface ForgeClient {
  getCurrentUser(): Promise<{ id: number; username: string; fullName?: string }>;
  isOrgMember(org: string, username: string): Promise<boolean>;
  listAccessibleRepos(query?: string): Promise<RepoRef[]>;
  getRepo(owner: string, repo: string): Promise<{ defaultBranch: string }>;
  getBranchHead(owner: string, repo: string, branch: string): Promise<string>; // sha
  getTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]>;
  getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  listIssueTemplates(owner: string, repo: string, ref: string): Promise<IssueTemplate[]>;
  listLabels(owner: string, repo: string): Promise<{ id: number; name: string }[]>;
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<{ number: number; url: string }>;
  addDependency(owner: string, repo: string, issue: number, dependsOn: number): Promise<void>;
  listIssuesCreatedBySince(owner: string, repo: string, username: string, since: Date): Promise<{ number: number; body: string; url: string }[]>;
}
```

Implement retries with jittered backoff for 429/5xx inside `GiteaForge`, and throw a typed `ForgeError { status, retryable }`.

### Endpoints

| Method | Path | Kind | Behaviour |
|---|---|---|---|
| GET | `/api/health` | sync | DB ping; no auth |
| GET | `/api/auth/login` | sync | See "Auth endpoints"; no auth |
| GET | `/api/auth/callback` | sync | See "Auth endpoints"; no auth |
| POST | `/api/auth/logout` | sync | Clear session |
| GET | `/api/me` | sync | Current user |
| GET | `/api/gitea/repos?q=` | sync | Repos the user can access (for the picker) |
| GET | `/api/repos` | sync | Tracked repos |
| POST | `/api/repos` | sync | `{owner, name}` -> verify access via forge, insert |
| POST | `/api/raw-issues` | sync | `{repo_id, body}` -> rate-limit check, insert raw issue + run in one batch, trigger drafting job, return `{run_id}` |
| GET | `/api/runs/:id` | sync | Status, error, and created draft ids |
| POST | `/api/runs/:id/retry` | sync | Only `failed` runs -> reset to `queued`, re-trigger |
| GET | `/api/drafts?repo_id=&status=` | sync | List with deps (ids + gitea numbers) |
| GET | `/api/drafts/:id` | sync | Detail + events |
| PATCH | `/api/drafts/:id` | sync | `{title?, body?, labels?, version}`; 409 on version mismatch |
| PUT | `/api/drafts/:id/deps` | sync | `{depends_on_ids, version}`; same-repo + cycle check |
| POST | `/api/drafts/:id/approve` | sync | `draft -> approved`, sets `approved_by` |
| POST | `/api/drafts/:id/unapprove` | sync | `approved -> draft` |
| POST | `/api/drafts/:id/retry` | sync | `failed -> approved` |
| DELETE | `/api/drafts/:id` | sync | Only `draft` |
| POST | `/api/drafts/:id/post` | sync | Post one draft now (Section 7) |
| POST | `/api/drafts/:id/reconcile` | sync | Resolve a stuck `posting` (Section 7) |
| POST | `/api/repos/:id/post-queue` | sync -> bg | Trigger background posting of every ready draft in the repo |

Errors use one shape: `{ error: { code, message, details? } }`. Shared zod schemas for every request/response live in `packages/shared`. No endpoint emits CORS headers.

### Background functions

| Function | Path | Triggered by |
|---|---|---|
| `draft-run-background` | `/internal/draft-run` | `POST /api/raw-issues`, `POST /api/runs/:id/retry` |
| `post-queue-background` | `/internal/post-queue` | `POST /api/repos/:id/post-queue` |

- Enable background mode with `config.background = true` (or the `-background` filename suffix).
- The sync endpoint calls `fetch` against `${process.env.URL}/internal/...`. It sends the header `x-internal-secret: INTERNAL_JOB_SECRET`, the user's current (already refreshed) access token as `Authorization: Bearer`, and a JSON body containing the id. It awaits only the 202. The token travels server-to-server only.
- Background functions reject any request without a matching secret (constant-time compare) and then run `withAuth` on the bearer token, so org membership is re-checked.
- **Retries:** Netlify retries a background function that errors, after 1 minute and again after 2 more. Therefore: catch deterministic failures (validation errors, 4xx from Gitea, bad AI output after repair) -> mark the run/draft `failed` and **return normally**. Re-throw only transient failures (network, 429, 5xx) so the platform retry applies. Every job must be idempotent.
- **Token lifetime:** Gitea access tokens last 1 h. The 20-minute refresh margin in `withAuth` means the forwarded token has at least 20 minutes left when the job starts, which covers the 15-minute background limit. A platform retry arriving after the token has expired fails with 401. It is then marked `failed` with "sign in and retry" rather than retried.

---

## 6. Stage 1 -- Drafting pipeline (`pipeline/draft.ts`)

Runs inside `draft-run-background`. Update `runs.status` at each step so the UI can show progress.

1. **Start (idempotent).** Load the run. If `status = 'done'`, exit. Otherwise set `status = 'reading_repo'`, `attempts = attempts + 1`, `started_at = now()`.
2. **Resolve head.** `getRepo` -> `getBranchHead(default_branch)` -> `commit_sha`; store it on the run.
3. **Snapshot (cached).** If `repo_snapshots(repo_id, sha)` exists, reuse it. Otherwise:
   - `getTree(sha)` recursively (`recursive`, `page`, `per_page`), paging until complete.
   - Filter out `node_modules/`, `dist/`, `build/`, `.git/`, `vendor/`, lockfiles, binaries/media by extension, and files over 200 KB.
   - Fetch README (first match of `README*` at root).
   - Fetch issue templates **at the snapshot sha** by reading `.gitea/ISSUE_TEMPLATE/` (then `.github/ISSUE_TEMPLATE/`). Gitea 1.25's `GET /repos/{owner}/{repo}/issue_templates` has no `ref` parameter, so it is not used. Support both Markdown templates (front matter + body) and YAML issue forms. For YAML forms, convert fields into a Markdown skeleton of `### <field label>` sections, matching how Gitea renders a submitted form (empty optional fields become `_No response_`; dropdown values must be one of the listed options). Parsing YAML forms needs a YAML parser: **flag the dependency** (proposed: `yaml`) before adding it.
   - Fetch labels.
   - Insert the snapshot row (`ON CONFLICT DO NOTHING`).
4. **Select files** (`status = 'selecting_files'`, model `MODEL_SELECT`). Input: raw issue text, filtered path list with sizes, README excerpt (<= 3,000 chars). Output via forced tool call `select_files` -> `{ paths: string[] }`, max 20. Discard any path not in the tree.
5. **Fetch context.** `getRawFile(path, ref = sha)` for each selected path. Truncate each file to 400 lines and the total to ~150,000 characters, noting truncation inline.
6. **Draft** (`status = 'drafting'`, model `MODEL_DRAFT`). Input: raw issue, repo name, selected file contents, templates, label names. Output via forced tool call `submit_drafts`:

   ```json
   {
     "drafts": [
       {
         "key": "a",
         "title": "string (<= 255)",
         "body": "markdown that follows the chosen template's sections",
         "template_name": "bug_report.md | null",
         "labels": ["only names from the provided label list"],
         "depends_on": ["other draft keys"]
       }
     ],
     "reviewer_notes": "optional"
   }
   ```

   Prompt rules: 1-8 drafts; split only when work is genuinely separable; cite concrete file paths from the provided context; never invent labels; `depends_on` must reference keys in this response and be acyclic.
7. **Validate.** zod schema + key references + cycle check + label whitelist. On failure, make **one** repair call that includes the validation errors. Still invalid -> run `failed`.
8. **Sanitize.** Strip any `<!-- issue-pipeline:` markers from AI output so a model can't forge the posting marker.
9. **Commit (atomic).** One `db.batch`: insert drafts (`created_by` = raw issue author), map keys -> uuids and insert `draft_deps`, insert `created` events, set run `done` with token counts, `prompt_version`, and `finished_at`. Because drafts are written only here, a retried job never duplicates drafts.

**Prompts** live in `apps/api/prompts/` as TS modules exporting template strings (avoids bundling non-TS files), named with a version (`draftIssues.v1.ts`). Record the version on each run.

**Untrusted input.** Raw issue text and repo files are data, not instructions. Wrap them in clearly delimited tags and tell the model to ignore instructions inside them. The real control is the human approval gate: nothing reaches Gitea without `approved`.

---

## 7. Stage 2 -- Posting (`pipeline/post.ts`, no AI)

### `postDraft(draftId, user, forge)`

1. **Claim** with the atomic UPDATE (Section 4). Zero rows -> 409 with the specific reason.
2. **Build body:** `draft.body`, then a `**Depends on:** #12, #15` line using the dependencies' `gitea_number`s (if any), then the hidden marker `<!-- issue-pipeline:draft:{draft_id} -->`. *(Open: when the template has a "Dependencies / blockers" section, insert the links there instead. Decide in Phase 4.)*
3. **Labels:** map names -> ids from `listLabels`; drop unknown names and record them in the event detail.
4. **Create:** `createIssue` with the user's token, so the issue is authored by that user.
5. **Record immediately:** `UPDATE drafts SET status='posted', gitea_number, gitea_url, updated_at WHERE id = $1 AND status = 'posting'`, plus a `posted` event.
6. **Link dependencies:** for each dependency, `addDependency(issue, depends_on_number)` -> set `linked_in_gitea = true`. A failure here does not undo the post; record a `link_failed` event (reconcile retries it). **VERIFY** that issue dependencies are enabled on each target repo (the API endpoints exist on Gitea 1.25).

Error handling:

- Failure **before** step 4, or a definite 4xx from step 4 -> `failed` with `last_error`.
- Ambiguous failure **during** step 4 (timeout, connection reset, 5xx) -> leave the draft in `posting`; reconcile decides.

### `reconcile(draftId)`

Allowed when the draft is `posting` and `claimed_at` is older than 5 minutes, or when a `posted` draft has unlinked dependencies.

1. `listIssuesCreatedBySince(claimed_by.username, claimed_at - 1 min)` (Gitea list-issues `created_by` + `since`) and search bodies for the draft's marker.
2. Found -> mark `posted` with that number. Not found -> return to `approved`.
3. Retry any dependency links where `linked_in_gitea = false` and both sides are posted.
4. Record a `reconciled` event with the outcome.

### Post queue (`post-queue-background`)

Loop: select the oldest `approved` draft in the repo whose dependencies are all `posted`; `postDraft` it; repeat. Stop when none are ready, after 50 posts, or after 3 consecutive failures. Because each iteration re-checks readiness, dependencies are posted before dependents without an explicit topological sort.

---

## 8. Web app (`apps/web`)

TypeScript + Vite + React + TanStack Query. Types and zod schemas come from `packages/shared`.

### API access (`lib/api.ts`)

- Same-origin `fetch` only. The browser attaches the session cookie automatically; the app never reads or stores a token, and uses no `localStorage` for credentials.
- Requests with a body send `Content-Type: application/json` (the browser adds `Origin`), which satisfies the CSRF check.
- Every response is parsed with its shared zod schema; errors map to the shared error shape.
- A `401` anywhere sends the user to `/login?return_to=<current path>`. A `403` from the org gate shows a "not a member of the organization" screen with a sign-out button.

### Sign-in

- "Sign in with Gitea" is a plain navigation to `/api/auth/login?return_to=...` (not `fetch`), so the whole OAuth flow is top-level redirects.
- `/login?error=not_member` and `/login?error=denied` render explanatory messages.
- On load, `GET /api/me` decides between the signed-in app and the login screen.

### Screens

| Screen | Contents |
|---|---|
| Login | "Sign in with Gitea" button; error states (denied, not a member, session expired) |
| Repos | Tracked repos; search accessible repos and track one |
| New issue | Repo select + raw text area -> submit -> run progress (poll `/api/runs/:id` every 2 s until `done`/`failed`), then jump to the new drafts |
| Board | Columns by status: Draft, Approved, Posting, Posted, Failed; repo filter; "Post all ready" button |
| Draft editor | Title, Markdown body with preview, label picker (repo labels), dependency picker (same-repo drafts), approve/unapprove, event history. On 409, show "Edited by someone else" with reload |
| Card actions | Post, Retry (failed), Reconcile (stale posting), open in Gitea (posted) |

Board data refreshes every 10 s while visible, and every 2 s while any draft is `posting`.

**Markdown preview renders AI-written text, so it must not render raw HTML** (for example `react-markdown` without `rehype-raw`). Flag the chosen library as a dependency in Phase 3.

Routing uses a small in-app router or conditional rendering; adding a router library is a dependency to flag.

### Security headers (`netlify.toml`)

Applied to the site:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: <GITEA_BASE_URL>; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin` (the callback overrides with `no-referrer`)
- API responses: `Cache-Control: no-store`

---

## 9. Deployment

1. **One Netlify site** built from `main`: build command compiles `packages/shared` and `apps/web`; `publish = apps/web/dist`; `functions = apps/api/netlify/functions`.
2. **Environments:** production uses the Neon production branch; local dev (`netlify dev`) uses the Neon `dev` branch. Migrations are applied with `pnpm db:migrate` before a deploy that needs them.
3. **Gitea OAuth app:** confidential client with redirect URIs `https://<production-site>/api/auth/callback` and `http://localhost:8888/api/auth/callback`.
4. **Secrets** (`GITEA_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `INTERNAL_JOB_SECRET`) live only in Netlify environment variables and the local, gitignored `.env`.
5. **Key rotation:** set the new key as `SESSION_SECRET` and the old one as `SESSION_SECRET_PREVIOUS`; remove the old key after `SESSION_MAX_AGE_DAYS`.
6. **Deploy previews** build and serve the UI and `/api/health`, but sign-in is unsupported there (their URLs are not registered redirect URIs).

---

## 10. Security checklist

- [ ] The client bundle contains no secrets and no build-time configuration.
- [ ] Gitea tokens exist only inside the encrypted `HttpOnly` session cookie and in request memory; never in Postgres, logs, URLs, or JavaScript-readable storage.
- [ ] Session cookie: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, AES-256-GCM with cookie-name AAD, absolute max age enforced server-side.
- [ ] OAuth: `state` + PKCE S256, confidential client, exact redirect URIs, `return_to` restricted to relative paths, non-members get no session.
- [ ] CSRF: `Origin` must match on every cookie-authenticated non-GET request; JSON content type required for bodies.
- [ ] Org membership checked on every request, including inside background functions.
- [ ] `/internal/*` requires `INTERNAL_JOB_SECRET` (constant-time compare).
- [ ] Nothing posts to Gitea without an `approved` status set by a human.
- [ ] AI output sanitized (marker stripping, label whitelist, length limits) and Markdown rendered without raw HTML.
- [ ] Per-user daily run cap enforced from the `runs` table.
- [ ] Input size limits enforced by zod on every endpoint.
- [ ] No CORS headers anywhere; security headers (CSP, `frame-ancestors 'none'`, `nosniff`, referrer policy) set.

---

## 11. Testing

- **Unit (vitest, `apps/api`):**
  - Graph helpers (cycle detection, readiness) and key->uuid mapping.
  - Template parsing (Markdown + YAML forms) and the body/marker builder.
  - AI output validation and sanitizing, and tree filtering.
  - Session crypto: round trip, tampering, wrong key, rotation key, AAD swap between cookies, max age, size under 4 KB.
  - CSRF check, OAuth callback (state mismatch, denied, non-member), `return_to` validation, refresh paths (success, rejected, transport error).
- **Unit (vitest, `apps/web`):** the API wrapper's 401/403 handling.
- **Integration:** a Neon branch dedicated to tests + a local Gitea in Docker (`gitea/gitea`). `scripts/seed_gitea.py` (Python, `requests`) creates:
  - an admin token, a test org, and users;
  - a repo with `.gitea/ISSUE_TEMPLATE/bug_report.md` and one YAML form;
  - labels, with issue dependencies enabled.

  Tests authenticate with Gitea personal access tokens sent as `Authorization: Bearer`, the path `withAuth` accepts for non-browser clients.
- **LLM:** mock `llm/anthropic.ts` with recorded fixtures in CI; one opt-in live test behind `LIVE_LLM=1`.
- **Failure injection:** kill the process between `createIssue` and the DB update, then run reconcile and assert no duplicate issue.
- **Smoke:** `scripts/smoke_test.py` runs raw issue -> drafts -> approve -> post against a deployed environment, using a bearer PAT.

---

## 12. Build phases

Each phase ends with its acceptance criteria passing and a short summary back to Kayela.

### Phase 0 -- Scaffold (done, as Tauri)
- pnpm monorepo, `packages/shared`, Netlify site with `/api/health`, Drizzle schema + first migration applied to the Neon dev branch, and a Tauri app calling `/api/health`.
- The Tauri shell is replaced in Phase 1.

### Phase 1 -- Web shell and auth
- Convert the client: move the React code from `apps/desktop` to `apps/web`, delete `src-tauri`, and have `netlify dev` serve the SPA and functions on one origin. `lib/api.ts` becomes a `fetch` wrapper.
- Session crypto, `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`, `withAuth` (cookie or bearer, CSRF, refresh, org gate), `/api/me`, security headers, and the Login screen.
- Keep what already exists from the first Phase 1 pass: `GiteaForge` (identity + org check), the user upsert, `/api/me`, and their tests.
- **Accept:**
  - Sign-in works at `http://localhost:8888` and persists across browser restarts until the max age; sign-out clears it.
  - A non-member is refused a session and sees the "not a member" message; a member removed from the org gets 403 on the next request.
  - A cross-origin POST with the cookie is rejected.
  - No token appears in JavaScript-readable storage, in network responses visible in devtools, in the address bar after the callback, or in function logs.

### Phase 2 -- Repos and drafting
- `ForgeClient` (full) + `GiteaForge`, repo tracking, snapshot caching, both AI calls, validation/repair, background job with idempotency and retry rules, run polling UI.
- **Accept:** a raw issue produces valid drafts with dependencies; a second run on the same commit reuses the snapshot; a forced AI failure marks the run `failed` with a readable error; a forced transient error followed by a platform retry produces no duplicate drafts.

### Phase 3 -- Review UI
- Board, draft editor, dependency picker, approve/unapprove, optimistic concurrency.
- **Accept:** two browser sessions editing the same draft -> the second gets 409; a cyclic dependency is rejected; approved drafts are read-only until unapproved; Markdown preview does not execute HTML from draft bodies.

### Phase 4 -- Posting
- `postDraft`, dependency linking, reconcile, post queue.
- **Accept:** the posted issue appears in Gitea authored by the posting user with the hidden marker; dependencies post first and are linked; posting a blocked draft returns 409 naming the unposted dependencies; the failure-injection test yields exactly one issue after reconcile.

### Phase 5 -- Production deployment
- Production Netlify site and env vars, Neon production branch + migrations, production redirect URI on the Gitea OAuth app, `scripts/smoke_test.py`.
- **Accept:** sign-in works on the production URL; the smoke test passes against production.

### Phase 6 -- Hardening
- Rate limits, per-run token/cost display, audit history view, structured logging with token redaction, session key rotation drill.
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
6. **Posting identity:** issues are authored by the posting user (default taken).
7. **Approval policy:** a user may approve their own drafts, recorded in `approved_by` (default taken).

Still to verify before the phase that depends on them:

| Item | Needed by | Status |
|---|---|---|
| Gitea OAuth app switched to **confidential**, local redirect URI registered | Phase 1 | Done (Kayela, 2026-09-12); production URI in Phase 5 |
| `[oauth2] INVALIDATE_REFRESH_TOKENS` is `false` on the instance (default) | Phase 1 | Outstanding |
| `/api/*` functions take precedence over the SPA fallback redirect | Phase 1 | Confirmed under `netlify dev`; re-check in production |
| A Gitea account outside `TrueRoster` for the 403 acceptance test | Phase 1 | Outstanding |
| Background Functions on the current Netlify plan | Phase 2 | Outstanding |
| YAML parser dependency for issue forms | Phase 2 | Awaiting approval |
| Issue dependencies enabled on each target repo | Phase 4 | Outstanding |
| Dependency links inside the template's "Dependencies / blockers" section vs. an appended line | Phase 4 | Open |
