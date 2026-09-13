import {
  apiErrorSchema,
  createRawIssueResponseSchema,
  draftListResponseSchema,
  giteaRepoListResponseSchema,
  healthResponseSchema,
  meResponseSchema,
  repoListResponseSchema,
  repoSchema,
  runListResponseSchema,
  runResponseSchema,
  type ApiErrorCode,
  type Draft,
  type GiteaRepo,
  type HealthResponse,
  type MeResponse,
  type Repo,
  type RunResponse,
  type RunSummary,
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

export async function searchGiteaRepos(query: string): Promise<GiteaRepo[]> {
  const q = encodeURIComponent(query);
  return (await request("GET", `/api/gitea/repos?q=${q}`, giteaRepoListResponseSchema)).repos;
}

export function trackRepo(owner: string, name: string): Promise<Repo> {
  return request("POST", "/api/repos", repoSchema, { owner, name });
}

export async function createRawIssue(repoId: string, body: string): Promise<string> {
  return (await request("POST", "/api/raw-issues", createRawIssueResponseSchema, { repo_id: repoId, body })).run_id;
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
