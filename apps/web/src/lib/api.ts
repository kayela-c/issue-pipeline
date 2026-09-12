import type { z } from "zod";
import {
  apiErrorSchema,
  healthResponseSchema,
  meResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
  type MeResponse,
} from "@issue-pipeline/shared";

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
