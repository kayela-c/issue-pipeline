import { invoke } from "@tauri-apps/api/core";
import type { z } from "zod";
import {
  apiErrorSchema,
  healthResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@issue-pipeline/shared";

/**
 * Typed wrapper around the Rust `api_request` command.
 *
 * The React layer never sees a base URL, a token, or a raw fetch. It names a
 * path; Rust decides which host that reaches and what credentials go with it.
 */

type RawResponse = { status: number; json: unknown };

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

async function request<T>(
  method: Method,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  let raw: RawResponse;
  try {
    raw = await invoke<RawResponse>("api_request", { method, path, body });
  } catch (err) {
    // invoke rejects with a string from the Rust side.
    throw new ApiError("transport", String(err), 0);
  }

  if (raw.status >= 400) {
    const parsed = apiErrorSchema.safeParse(raw.json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(code, message, raw.status, details);
    }
    throw new ApiError(
      "invalid_response",
      `Request failed with status ${raw.status}`,
      raw.status,
      raw.json,
    );
  }

  const parsed = schema.safeParse(raw.json);
  if (!parsed.success) {
    throw new ApiError(
      "invalid_response",
      "The server returned a response this client does not understand.",
      raw.status,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function getHealth(): Promise<HealthResponse> {
  return request("GET", "/api/health", healthResponseSchema);
}
