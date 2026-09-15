import {
  aiModelListResponseSchema,
  aiSettingsResponseSchema,
  aiTestResponseSchema,
  apiErrorSchema,
  connectionsResponseSchema,
  createRawIssueResponseSchema,
  draftDetailSchema,
  draftListResponseSchema,
  giteaRepoListResponseSchema,
  healthResponseSchema,
  issueTemplateSchema,
  templateListResponseSchema,
  templatePreviewResponseSchema,
  meResponseSchema,
  repoLabelsResponseSchema,
  repoListResponseSchema,
  repoSchema,
  runListResponseSchema,
  runResponseSchema,
  type AiModel,
  type AiProvider,
  type AiSettingsResponse,
  type AiTestResponse,
  type ApiErrorCode,
  type ConnectableForge,
  type Connection,
  type CreateTemplateRequest,
  type Draft,
  type IssueTemplateDto,
  type TemplatePreviewRequest,
  type TemplatePreviewResponse,
  type UpdateTemplateRequest,
  type DraftDetail,
  type GiteaRepo,
  type HealthResponse,
  type MeResponse,
  type Repo,
  type RepoForge,
  type RunResponse,
  type RunSummary,
  type UpdateAiProviderRequest,
  type UpdateDraftRequest,
} from "@issue-pipeline/shared";
import { z } from "zod";

/**
 * Typed wrapper around same-origin fetch.
 *
 * The browser attaches the HttpOnly session cookie by itself; this code never
 * sees or stores a token. Request bodies are JSON, which (with the Origin
 * header the browser adds) is what the API's CSRF check expects.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | "invalid_response" | "transport",
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function request<T>(
  method: Method,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("transport", "Could not reach the server. Check your connection.", 0);
  }

  const json: unknown = res.status === 204 ? null : await res.json().catch(() => undefined);

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(code, message, res.status, details);
    }
    throw new ApiError("invalid_response", `Request failed with status ${res.status}`, res.status, json);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      "invalid_response",
      "The server returned a response this app does not understand.",
      res.status,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function getHealth(): Promise<HealthResponse> {
  return request("GET", "/api/health", healthResponseSchema);
}

export function getMe(): Promise<MeResponse> {
  return request("GET", "/api/me", meResponseSchema);
}

export async function listRepos(): Promise<Repo[]> {
  return (await request("GET", "/api/repos", repoListResponseSchema)).repos;
}

/** Repos the caller can see on a forge, for the "track a repo" picker. GitHub answers 409 not_connected without a connection. */
export async function searchForgeRepos(forge: RepoForge, query: string): Promise<GiteaRepo[]> {
  const q = encodeURIComponent(query);
  return (await request("GET", `/api/${forge}/repos?q=${q}`, giteaRepoListResponseSchema)).repos;
}

export function trackRepo(forge: RepoForge, owner: string, name: string): Promise<Repo> {
  return request("POST", "/api/repos", repoSchema, { forge, owner, name });
}

/** A 409 telling the caller to connect a forge in Settings before using its repos. */
export const isNotConnected = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.code === "conflict" &&
  (error.details as { reason?: unknown } | undefined)?.reason === "not_connected";

export async function createRawIssue(repoId: string, body: string, templateId: string | null = null): Promise<string> {
  return (
    await request("POST", "/api/raw-issues", createRawIssueResponseSchema, { repo_id: repoId, body, template_id: templateId })
  ).run_id;
}

export async function listRuns(): Promise<RunSummary[]> {
  return (await request("GET", "/api/runs?limit=100", runListResponseSchema)).runs;
}

export function getRun(runId: string): Promise<RunResponse> {
  return request("GET", `/api/runs/${encodeURIComponent(runId)}`, runResponseSchema);
}

export async function retryRun(runId: string): Promise<void> {
  await request("POST", `/api/runs/${encodeURIComponent(runId)}/retry`, z.object({ run_id: z.uuid() }), {});
}

export async function listRunDrafts(runId: string): Promise<Draft[]> {
  return (await request("GET", `/api/drafts?run_id=${encodeURIComponent(runId)}`, draftListResponseSchema)).drafts;
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!res.ok) {
    throw new ApiError("invalid_response", `Sign-out failed with status ${res.status}`, res.status);
  }
}

/** Sign-in is a full-page navigation: the OAuth flow is a chain of redirects. */
export function startLogin(returnTo: string): void {
  window.location.assign(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`);
}

/**
 * Start GitHub OAuth: signed out, this signs in through a previously linked
 * account; signed in (from Settings), it links GitHub to the current account.
 */
export function startGithubLogin(returnTo: string): void {
  window.location.assign(`/api/auth/github/login?return_to=${encodeURIComponent(returnTo)}`);
}

// --- Review ---------------------------------------------------------------------

export async function listDrafts(filter: { repoId?: string } = {}): Promise<Draft[]> {
  const query = filter.repoId ? `?repo_id=${encodeURIComponent(filter.repoId)}` : "";
  return (await request("GET", `/api/drafts${query}`, draftListResponseSchema)).drafts;
}

export function getDraft(id: string): Promise<DraftDetail> {
  return request("GET", `/api/drafts/${encodeURIComponent(id)}`, draftDetailSchema);
}

export function updateDraft(id: string, patch: UpdateDraftRequest): Promise<DraftDetail> {
  return request("PATCH", `/api/drafts/${encodeURIComponent(id)}`, draftDetailSchema, patch);
}

export function updateDraftDeps(id: string, dependsOnIds: string[], version: number): Promise<DraftDetail> {
  return request("PUT", `/api/drafts/${encodeURIComponent(id)}/deps`, draftDetailSchema, {
    depends_on_ids: dependsOnIds,
    version,
  });
}

export function approveDraft(id: string, version: number): Promise<DraftDetail> {
  return request("POST", `/api/drafts/${encodeURIComponent(id)}/approve`, draftDetailSchema, { version });
}

export function unapproveDraft(id: string): Promise<DraftDetail> {
  return request("POST", `/api/drafts/${encodeURIComponent(id)}/unapprove`, draftDetailSchema, {});
}

export async function deleteDraft(id: string): Promise<void> {
  await request("DELETE", `/api/drafts/${encodeURIComponent(id)}`, z.null());
}

export async function getRepoLabels(repoId: string): Promise<Array<{ id: number; name: string }>> {
  return (await request("GET", `/api/repos/${encodeURIComponent(repoId)}/labels`, repoLabelsResponseSchema)).labels;
}

// --- Posting ----------------------------------------------------------------------

export function retryDraft(id: string): Promise<DraftDetail> {
  return request("POST", `/api/drafts/${encodeURIComponent(id)}/retry`, draftDetailSchema, {});
}

export function postDraft(id: string): Promise<DraftDetail> {
  return request("POST", `/api/drafts/${encodeURIComponent(id)}/post`, draftDetailSchema, {});
}

export function reconcileDraft(id: string): Promise<DraftDetail> {
  return request("POST", `/api/drafts/${encodeURIComponent(id)}/reconcile`, draftDetailSchema, {});
}

export async function postQueue(repoId: string): Promise<void> {
  await request("POST", `/api/repos/${encodeURIComponent(repoId)}/post-queue`, z.object({}), {});
}

// --- Settings ---------------------------------------------------------------------

export function getAiSettings(): Promise<AiSettingsResponse> {
  return request("GET", "/api/settings/ai", aiSettingsResponseSchema);
}

export function selectAiProvider(provider: AiProvider | null): Promise<AiSettingsResponse> {
  return request("PUT", "/api/settings/ai", aiSettingsResponseSchema, { provider });
}

export function updateAiProvider(provider: AiProvider, update: UpdateAiProviderRequest): Promise<AiSettingsResponse> {
  return request("PUT", `/api/settings/ai/${provider}`, aiSettingsResponseSchema, update);
}

export async function listAiModels(provider: AiProvider): Promise<AiModel[]> {
  return (await request("GET", `/api/settings/ai/${provider}/models`, aiModelListResponseSchema)).models;
}

export function testAiProvider(provider: AiProvider): Promise<AiTestResponse> {
  return request("POST", `/api/settings/ai/${provider}/test`, aiTestResponseSchema, {});
}

export async function listTemplates(): Promise<IssueTemplateDto[]> {
  return (await request("GET", "/api/templates", templateListResponseSchema)).templates;
}

export function createTemplate(input: CreateTemplateRequest): Promise<IssueTemplateDto> {
  return request("POST", "/api/templates", issueTemplateSchema, input);
}

export function updateTemplate(id: string, input: UpdateTemplateRequest): Promise<IssueTemplateDto> {
  return request("PATCH", `/api/templates/${encodeURIComponent(id)}`, issueTemplateSchema, input);
}

export async function deleteTemplate(id: string): Promise<void> {
  await request("DELETE", `/api/templates/${encodeURIComponent(id)}`, z.null());
}

export function previewTemplate(input: TemplatePreviewRequest): Promise<TemplatePreviewResponse> {
  return request("POST", "/api/template-preview", templatePreviewResponseSchema, input);
}

export async function listConnections(): Promise<Connection[]> {
  return (await request("GET", "/api/settings/connections", connectionsResponseSchema)).connections;
}

export async function disconnectForge(forge: ConnectableForge): Promise<void> {
  await request("DELETE", `/api/settings/connections/${forge}`, z.null());
}
