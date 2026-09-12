# Issue Pipeline — Architecture Plan

> Handoff document for Claude Code. Working name: `issue-pipeline` (rename freely).

## 0. Instructions for Claude Code

1. Build **one phase at a time** (Section 12). Stop at the end of each phase, summarize what was built, and list anything that deviated from this plan.
2. Items marked **VERIFY** must be checked against the real Gitea instance, Netlify plan, or current docs before the code depends on them. If a VERIFY item turns out false, stop and report instead of improvising a workaround.
3. Do not add dependencies beyond those listed without flagging them first. No LangChain or agent frameworks; AI calls go straight through `@anthropic-ai/sdk`.
4. Standalone utility scripts (seeding, smoke tests, maintenance) are written in **Python**. Application code is TypeScript (API, UI) and Rust (Tauri shell).
5. Never log, persist server-side, or expose to the React layer any Gitea token or API key.

---

## 1. Purpose

A desktop app for a small team that turns rough issue notes into well-formed Gitea issues.

**Stage 1 — Drafting (AI).** A user submits raw issue text against a repo. The system reads the repo through the Gitea API, and an AI produces one or more issue drafts that follow the repo's Gitea issue template, including dependencies between the drafts. Drafts land in the database for human review.

**Stage 2 — Posting (no AI).** A teammate approves drafts. An approved draft whose dependencies are all posted is claimed atomically, created in Gitea under the posting user's account, linked to its dependencies, and marked `posted` with its issue number. This stage is deterministic code only.

**Non-goals for v1:** offline mode, GitHub support (keep the adapter seam, implement Gitea only), syncing edits back from Gitea after posting, auto-posting without approval, Excel import/export, cross-repo dependencies.

---

## 2. Architecture overview

```
Desktop app (Tauri 2, one per teammate)
  │  React UI → Rust commands → HTTPS.  Tokens live in the OS keychain (Rust only).
  │
  ├── OAuth2 + PKCE login ───────────▶ Gitea
  │
  └── Bearer <user's Gitea token> ───▶ Netlify Functions (TypeScript)
                                          ├── Neon Postgres    state + queue
                                          ├── Gitea REST API   read repo, post issues (as the user)
                                          └── Anthropic API    Stage 1 drafting only
```

| Decision | Choice | Why |
|---|---|---|
| Source of truth | Neon Postgres | Shared team queue; Gitea is the system of record once posted |
| API layer | Netlify Functions v2 (TS) | No DB credentials or AI keys ship in the installer |
| Long work | Netlify Background Functions | Sync functions cap at 60 s by default; background functions allow 15 min |
| Orchestration | Plain code, no n8n | Two linear stages; one repo; versioned with the app |
| Identity | Gitea OAuth2 (public client + PKCE) | No separate user system; issues are authored by the real user |
| Access control | Membership in one Gitea org | Simple team gate |
| AI usage | Two narrow calls in Stage 1 only | Posting stays predictable and cheap |
| Forge access | `ForgeClient` interface, Gitea implementation | Keeps GitHub possible later without a rewrite |
| Realtime | Polling (2 s while a run is active) | Functions are stateless; no websockets needed |

---

## 3. Repository layout

pnpm workspaces monorepo.

```
issue-pipeline/
├── apps/
│   ├── desktop/                     # Tauri 2 + React + TypeScript (Vite)
│   │   ├── src/                     # React UI
│   │   │   ├── lib/api.ts           # typed wrapper around invoke('api_request')
│   │   │   ├── routes/              # Login, Repos, NewIssue, Board, DraftEditor
│   │   │   └── components/
│   │   └── src-tauri/
│   │       ├── src/main.rs
│   │       ├── src/auth.rs          # PKCE flow, token refresh
│   │       ├── src/keychain.rs      # keyring wrapper
│   │       ├── src/api.rs           # reqwest client, api_request command
│   │       ├── capabilities/        # minimal Tauri permissions
│   │       └── tauri.conf.json
│   └── api/                         # Netlify site
│       ├── netlify/functions/       # one file per endpoint group + 2 background fns
│       ├── src/
│       │   ├── db/schema.ts         # Drizzle schema (matches Section 4)
│       │   ├── db/client.ts         # neon-http + drizzle
│       │   ├── auth.ts              # withAuth() wrapper
│       │   ├── forge/types.ts       # ForgeClient interface
│       │   ├── forge/gitea.ts       # Gitea implementation
│       │   ├── llm/anthropic.ts     # thin SDK wrapper, tool-use JSON output
│       │   ├── pipeline/draft.ts    # Stage 1
│       │   ├── pipeline/post.ts     # Stage 2
│       │   └── pipeline/graph.ts    # cycle detection, topo helpers
│       ├── prompts/                 # versioned prompts as TS string modules
│       ├── drizzle/                 # generated migrations
│       ├── netlify.toml
│       └── drizzle.config.ts
├── packages/
│   └── shared/                      # zod schemas + inferred TS types (API contract)
├── scripts/                         # Python utilities (seed_gitea.py, smoke_test.py)
├── docs/ARCHITECTURE.md             # this file
└── pnpm-workspace.yaml
```

---

## 4. Data model (Neon Postgres)

Define this in Drizzle (`apps/api/src/db/schema.ts`), generate the migration with `drizzle-kit`, and confirm the generated SQL matches the DDL below. Statuses use `text` + `CHECK` rather than enums so they are easy to extend.

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
draft ──approve──▶ approved ──claim──▶ posting ──success──▶ posted
  ▲                  │  ▲                 │
  └───unapprove──────┘  └──retry── failed ◀┘ (error before issue was created)
                           ▲
               posting (stale > 5 min) ──reconcile──▶ posted | approved
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

**Stack:** Netlify Functions v2 (`export default async (req, context)` with `export const config = { path }`), Drizzle ORM over `@neondatabase/serverless` (HTTP driver), `zod` for every request and AI output, `@anthropic-ai/sdk`. No web framework. Use single statements where possible and `db.batch([...])` for multi-statement atomic writes.

### Environment variables (Netlify)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string (existing Neon project) |
| `ANTHROPIC_API_KEY` | Stage 1 only |
| `MODEL_SELECT` | File-selection model, default `claude-haiku-4-5-20251001` |
| `MODEL_DRAFT` | Drafting model, default `claude-sonnet-5` |
| `GITEA_BASE_URL` | e.g. `https://git.example.com` |
| `GITEA_ALLOWED_ORG` | Only members of this org may use the API |
| `INTERNAL_JOB_SECRET` | Shared secret for background-function calls |
| `MAX_RUNS_PER_USER_PER_DAY` | Cost guard, default `50` |

Confirm current model IDs at docs.claude.com before shipping; keep them env-configurable.

### Auth wrapper — `withAuth(handler)`

1. Read `Authorization: Bearer <token>`; missing → 401.
2. `GET {GITEA_BASE_URL}/api/v1/user` with that token; non-200 → 401.
3. `GET /api/v1/orgs/{GITEA_ALLOWED_ORG}/members/{username}`; 204 = member, otherwise 403.
4. Upsert `users` by `gitea_id`, update `last_seen_at`.
5. Call `handler(req, { user, giteaToken, forge })`, where `forge` is a `GiteaForge` bound to the user's token.

Tokens are held in memory for the request only. Redact the `Authorization` header in any error logging.

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
| GET | `/api/me` | sync | Current user |
| GET | `/api/gitea/repos?q=` | sync | Repos the user can access (for the picker) |
| GET | `/api/repos` | sync | Tracked repos |
| POST | `/api/repos` | sync | `{owner, name}` → verify access via forge, insert |
| POST | `/api/raw-issues` | sync | `{repo_id, body}` → rate-limit check, insert raw issue + run in one batch, trigger drafting job, return `{run_id}` |
| GET | `/api/runs/:id` | sync | Status, error, and created draft ids |
| POST | `/api/runs/:id/retry` | sync | Only `failed` runs → reset to `queued`, re-trigger |
| GET | `/api/drafts?repo_id=&status=` | sync | List with deps (ids + gitea numbers) |
| GET | `/api/drafts/:id` | sync | Detail + events |
| PATCH | `/api/drafts/:id` | sync | `{title?, body?, labels?, version}`; 409 on version mismatch |
| PUT | `/api/drafts/:id/deps` | sync | `{depends_on_ids, version}`; same-repo + cycle check |
| POST | `/api/drafts/:id/approve` | sync | `draft → approved`, sets `approved_by` |
| POST | `/api/drafts/:id/unapprove` | sync | `approved → draft` |
| POST | `/api/drafts/:id/retry` | sync | `failed → approved` |
| DELETE | `/api/drafts/:id` | sync | Only `draft` |
| POST | `/api/drafts/:id/post` | sync | Post one draft now (Section 7) |
| POST | `/api/drafts/:id/reconcile` | sync | Resolve a stuck `posting` (Section 7) |
| POST | `/api/repos/:id/post-queue` | sync → bg | Trigger background posting of every ready draft in the repo |

Errors use one shape: `{ error: { code, message, details? } }`. Shared zod schemas for every request/response live in `packages/shared`.

### Background functions

| Function | Path | Triggered by |
|---|---|---|
| `draft-run-background` | `/internal/draft-run` | `POST /api/raw-issues`, `POST /api/runs/:id/retry` |
| `post-queue-background` | `/internal/post-queue` | `POST /api/repos/:id/post-queue` |

- Enable background mode with `config.background = true` (or the `-background` filename suffix).
- The sync endpoint calls `fetch(`${process.env.URL}/internal/...`)` with header `x-internal-secret: INTERNAL_JOB_SECRET`, the user's forwarded `Authorization` header, and a JSON body containing the id. It awaits only the 202.
- Background functions reject any request without a matching secret (constant-time compare) and re-run `withAuth` on the forwarded token.
- **Retries:** Netlify retries a background function that errors, after 1 minute and again after 2 more. Therefore: catch deterministic failures (validation errors, 4xx from Gitea, bad AI output after repair) → mark the run/draft `failed` and **return normally**. Re-throw only transient failures (network, 429, 5xx) so the platform retry applies. Every job must be idempotent (below).
- **Token lifetime:** the forwarded Gitea access token must stay valid for the job. The desktop app refreshes its token before calling any job-triggering endpoint if it expires within 20 minutes. **VERIFY** the Gitea access-token lifetime (`[oauth2] ACCESS_TOKEN_EXPIRATION_TIME`, default believed to be 1 h).

---

## 6. Stage 1 — Drafting pipeline (`pipeline/draft.ts`)

Runs inside `draft-run-background`. Update `runs.status` at each step so the UI can show progress.

1. **Start (idempotent).** Load the run. If `status = 'done'`, exit. Otherwise set `status = 'reading_repo'`, `attempts = attempts + 1`, `started_at = now()`.
2. **Resolve head.** `getRepo` → `getBranchHead(default_branch)` → `commit_sha`; store it on the run.
3. **Snapshot (cached).** If `repo_snapshots(repo_id, sha)` exists, reuse it. Otherwise:
   - `getTree(sha)` recursively. **VERIFY** Gitea tree pagination and the `truncated` flag; page until complete.
   - Filter out `node_modules/`, `dist/`, `build/`, `.git/`, `vendor/`, lockfiles, binaries/media by extension, and files over 200 KB.
   - Fetch README (first match of `README*` at root).
   - Fetch issue templates: **VERIFY** `GET /repos/{owner}/{repo}/issue_templates` on your Gitea version; fall back to reading `.gitea/ISSUE_TEMPLATE/` and `.github/ISSUE_TEMPLATE/`. Support both Markdown templates (front matter + body) and YAML issue forms. For YAML forms, convert fields into a Markdown skeleton of `### <field label>` sections.
   - Fetch labels.
   - Insert the snapshot row (`ON CONFLICT DO NOTHING`).
4. **Select files** (`status = 'selecting_files'`, model `MODEL_SELECT`). Input: raw issue text, filtered path list with sizes, README excerpt (≤ 3,000 chars). Output via forced tool call `select_files` → `{ paths: string[] }`, max 20. Discard any path not in the tree.
5. **Fetch context.** `getRawFile(path, ref = sha)` for each selected path. Truncate each file to 400 lines and the total to ~150,000 characters, noting truncation inline.
6. **Draft** (`status = 'drafting'`, model `MODEL_DRAFT`). Input: raw issue, repo name, selected file contents, templates, label names. Output via forced tool call `submit_drafts`:

   ```json
   {
     "drafts": [
       {
         "key": "a",
         "title": "string (≤ 255)",
         "body": "markdown that follows the chosen template's sections",
         "template_name": "bug_report.md | null",
         "labels": ["only names from the provided label list"],
         "depends_on": ["other draft keys"]
       }
     ],
     "reviewer_notes": "optional"
   }
   ```

   Prompt rules: 1–8 drafts; split only when work is genuinely separable; cite concrete file paths from the provided context; never invent labels; `depends_on` must reference keys in this response and be acyclic.
7. **Validate.** zod schema + key references + cycle check + label whitelist. On failure, make **one** repair call that includes the validation errors. Still invalid → run `failed`.
8. **Sanitize.** Strip any `<!-- issue-pipeline:` markers from AI output so a model can't forge the posting marker.
9. **Commit (atomic).** One `db.batch`: insert drafts (`created_by` = raw issue author), map keys → uuids and insert `draft_deps`, insert `created` events, set run `done` with token counts, `prompt_version`, and `finished_at`. Because drafts are written only here, a retried job never duplicates drafts.

**Prompts** live in `apps/api/prompts/` as TS modules exporting template strings (avoids bundling non-TS files), named with a version (`draftIssues.v1.ts`). Record the version on each run.

**Untrusted input.** Raw issue text and repo files are data, not instructions. Wrap them in clearly delimited tags and tell the model to ignore instructions inside them. The real control is the human approval gate: nothing reaches Gitea without `approved`.

---

## 7. Stage 2 — Posting (`pipeline/post.ts`, no AI)

### `postDraft(draftId, user, forge)`

1. **Claim** with the atomic UPDATE (Section 4). Zero rows → 409 with the specific reason.
2. **Build body:** `draft.body`, then a `**Depends on:** #12, #15` line using the dependencies' `gitea_number`s (if any), then the hidden marker `<!-- issue-pipeline:draft:{draft_id} -->`.
3. **Labels:** map names → ids from `listLabels`; drop unknown names and record them in the event detail.
4. **Create:** `createIssue` with the user's token, so the issue is authored by that user.
5. **Record immediately:** `UPDATE drafts SET status='posted', gitea_number, gitea_url, updated_at WHERE id = $1 AND status = 'posting'`, plus a `posted` event.
6. **Link dependencies:** for each dependency, `addDependency(issue, depends_on_number)` → set `linked_in_gitea = true`. A failure here does not undo the post; record a `link_failed` event (reconcile retries it). **VERIFY** that issue dependencies are enabled on target repos and the endpoint path/body for your Gitea version.

Error handling:
- Failure **before** step 4, or a definite 4xx from step 4 → `failed` with `last_error`.
- Ambiguous failure **during** step 4 (timeout, connection reset, 5xx) → leave the draft in `posting`; reconcile decides.

### `reconcile(draftId)`

Allowed when the draft is `posting` and `claimed_at` is older than 5 minutes, or when a `posted` draft has unlinked dependencies.

1. `listIssuesCreatedBySince(claimed_by.username, claimed_at − 1 min)` and search bodies for the draft's marker. **VERIFY** that Gitea's list-issues endpoint supports `created_by` and `since`.
2. Found → mark `posted` with that number. Not found → return to `approved`.
3. Retry any dependency links where `linked_in_gitea = false` and both sides are posted.
4. Record a `reconciled` event with the outcome.

### Post queue (`post-queue-background`)

Loop: select the oldest `approved` draft in the repo whose dependencies are all `posted`; `postDraft` it; repeat. Stop when none are ready, after 50 posts, or after 3 consecutive failures. Because each iteration re-checks readiness, dependencies are posted before dependents without an explicit topological sort.

---

## 8. Desktop app (Tauri 2)

### Rust side (`src-tauri`)

Rust owns all secrets and all network calls. The React layer never sees a token.

**Crates:** `tauri` 2, `reqwest` (rustls), `serde`/`serde_json`, `tokio`, `keyring`, `sha2`, `base64`, `rand`, `url`, `thiserror`, `tauri-plugin-opener`, `tauri-plugin-updater`, and either `tauri-plugin-oauth` or a minimal `tiny_http` loopback listener.

**Login (OAuth2 authorization code + PKCE):**
1. Register a Gitea OAuth2 application as a **public client** (not confidential) with redirect URI `http://127.0.0.1/callback`. Gitea allows any port on a loopback redirect for public clients, so bind the listener to `127.0.0.1:0` and use the assigned port. Use `127.0.0.1`, not `localhost`.
2. Generate `code_verifier` (43–128 chars), `code_challenge` = base64url(SHA-256), and a random `state`.
3. Open `{GITEA}/login/oauth/authorize?client_id&redirect_uri&response_type=code&state&code_challenge&code_challenge_method=S256` in the system browser.
4. On callback, verify `state`, then POST to `{GITEA}/login/oauth/access_token` with `code`, `code_verifier`, `client_id`, `redirect_uri`, `grant_type=authorization_code` (no client secret).
5. Store `{access_token, refresh_token, expires_at}` in the OS keychain.
6. **VERIFY** which OAuth scopes your Gitea version supports; request the minimum needed: read user, read organization, read repository, write issue.

**Commands exposed to React:**

| Command | Purpose |
|---|---|
| `auth_login()` | Runs the flow above; returns the username |
| `auth_logout()` | Deletes keychain entries |
| `auth_status()` | `{ logged_in, username?, expires_at? }` |
| `api_request(method, path, body?)` | Attaches the bearer token and returns `{ status, json }` |

`api_request` refreshes proactively when the token expires within 20 minutes, and on a 401 refreshes once and retries. If refresh fails, it clears the keychain and returns `auth_required`.

**Capabilities:** grant only what's used (opener, updater, the custom commands). No `tauri-plugin-sql`, no general `fs` or `shell` access. Set a strict CSP.

**Build-time config** (compiled in, not secret): `API_BASE_URL`, `GITEA_BASE_URL`, `GITEA_OAUTH_CLIENT_ID`.

### React side (`src`)

TypeScript + Vite + TanStack Query. Types and zod schemas come from `packages/shared`; `lib/api.ts` wraps `invoke('api_request', …)` with typed functions.

| Screen | Contents |
|---|---|
| Login | "Sign in with Gitea" button; error states |
| Repos | Tracked repos; search accessible repos and track one |
| New issue | Repo select + raw text area → submit → run progress (poll `/api/runs/:id` every 2 s until `done`/`failed`), then jump to the new drafts |
| Board | Columns by status: Draft, Approved, Posting, Posted, Failed; repo filter; "Post all ready" button |
| Draft editor | Title, Markdown body with preview, label picker (repo labels), dependency picker (same-repo drafts), approve/unapprove, event history. On 409, show "Edited by someone else" with reload |
| Card actions | Post, Retry (failed), Reconcile (stale posting), open in Gitea (posted) |

Board data refreshes every 10 s while visible, and every 2 s while any draft is `posting`.

---

## 9. Distribution and updates

1. **Updater signing:** `pnpm tauri signer generate`; public key in `tauri.conf.json`, private key and password as CI secrets. Required by `tauri-plugin-updater`.
2. **Builds:** `pnpm tauri build` per OS in a CI matrix (Windows `.msi`/`.exe`, Linux `.AppImage`/`.deb`, macOS `.dmg` if a Mac runner is available; otherwise build macOS manually).
3. **Hosting:** a separate Netlify site (`issue-pipeline-downloads`), deployed by CI with `netlify deploy --prod --dir=release/`, holds installers, update bundles, and `latest.json`. Binaries never get committed to git.
4. **Updater endpoint:** point `tauri.conf.json` at `https://<downloads-site>/latest.json`.
5. **OS code signing:** optional for v1. Unsigned builds work but trigger SmartScreen/Gatekeeper warnings on first run.

---

## 10. Security checklist

- [ ] Installer contains no DB credentials, AI keys, or client secrets (public OAuth client only).
- [ ] Gitea tokens: keychain on the client; per-request only on the server; never stored in Postgres; redacted from logs.
- [ ] Org membership checked on every request, including inside background functions.
- [ ] `/internal/*` requires `INTERNAL_JOB_SECRET` (constant-time compare).
- [ ] Nothing posts to Gitea without an `approved` status set by a human.
- [ ] AI output sanitized (marker stripping, label whitelist, length limits).
- [ ] Per-user daily run cap enforced from the `runs` table.
- [ ] Input size limits enforced by zod on every endpoint.
- [ ] CORS closed (the desktop app calls from Rust, not a browser origin).

---

## 11. Testing

- **Unit (vitest, `apps/api`):** graph helpers (cycle detection, readiness), key→uuid mapping, template parsing (Markdown + YAML forms), body/marker builder, AI output validation and sanitizing, tree filtering.
- **Integration:** a Neon branch dedicated to tests + a local Gitea in Docker (`gitea/gitea`). `scripts/seed_gitea.py` (Python, `requests`) creates an admin token, a test org and users, a repo with `.gitea/ISSUE_TEMPLATE/bug_report.md` and one YAML form, labels, and enables issue dependencies. Tests authenticate with Gitea personal access tokens, which `/api/v1/user` accepts the same way as OAuth tokens.
- **LLM:** mock `llm/anthropic.ts` with recorded fixtures in CI; one opt-in live test behind `LIVE_LLM=1`.
- **Failure injection:** kill the process between `createIssue` and the DB update, then run reconcile and assert no duplicate issue.
- **Smoke:** `scripts/smoke_test.py` runs raw issue → drafts → approve → post against a deployed environment.

---

## 12. Build phases

Each phase ends with its acceptance criteria passing and a short summary back to Kayela.

### Phase 0 — Scaffold
- pnpm monorepo, `packages/shared`, Netlify site with `/api/health`, Drizzle schema + first migration applied to a Neon dev branch, Tauri app that calls `/api/health` via `api_request` (no auth yet).
- **Accept:** `netlify dev` returns `{db: "ok"}`; the desktop window shows it.

### Phase 1 — Auth
- PKCE login, keychain storage, refresh logic, `withAuth`, org gate, `/api/me`.
- **Accept:** login persists across restarts; logout clears it; a non-org user gets 403; tokens never appear in React state, devtools, or logs.

### Phase 2 — Repos and drafting
- `ForgeClient` + `GiteaForge`, repo tracking, snapshot caching, both AI calls, validation/repair, background job with idempotency and retry rules, run polling UI.
- **Accept:** a raw issue produces valid drafts with dependencies; a second run on the same commit reuses the snapshot; a forced AI failure marks the run `failed` with a readable error; a forced transient error followed by a platform retry produces no duplicate drafts.

### Phase 3 — Review UI
- Board, draft editor, dependency picker, approve/unapprove, optimistic concurrency.
- **Accept:** two clients editing the same draft → the second gets 409; a cyclic dependency is rejected; approved drafts are read-only until unapproved.

### Phase 4 — Posting
- `postDraft`, dependency linking, reconcile, post queue.
- **Accept:** the posted issue appears in Gitea authored by the posting user with the hidden marker; dependencies post first and are linked; posting a blocked draft returns 409 naming the unposted dependencies; the failure-injection test yields exactly one issue after reconcile.

### Phase 5 — Distribution
- Updater keys, CI builds, downloads site.
- **Accept:** install v0.1.0, publish v0.1.1, and the installed app updates itself.

### Phase 6 — Hardening
- Rate limits, per-run token/cost display, audit history view, structured logging with token redaction.
- **Accept:** security checklist in Section 10 fully ticked.

---

## 13. VERIFY before building (blocking questions)

1. **Gitea reachability:** Netlify Functions must reach Gitea over public HTTPS. If Gitea is only on a private network or VPN, this architecture needs a different API host.
2. **Gitea version** — confirm: issue templates endpoint, recursive tree pagination, issue dependencies API (and that dependencies are enabled per repo), `created_by`/`since` on list-issues, supported OAuth scopes, access-token lifetime.
3. **Netlify plan:** confirm Background Functions are available on the current plan.
4. **Posting identity:** default is "issues authored by the posting user." The alternative is a bot account with "requested by @user" in the body. Confirm the default.
5. **Approval policy:** can a user approve their own drafts? Default: yes, recorded in `approved_by`.
6. **macOS:** is a Mac build needed in v1?
