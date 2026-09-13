import { API_ERROR_STATUS, type ApiErrorCode } from "@issue-pipeline/shared";
import type { z } from "zod";

/** Largest JSON body any endpoint accepts. The biggest legitimate one is a 20k-char raw issue. */
const MAX_BODY_BYTES = 64 * 1024;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // The desktop app calls this API from Rust, not from a browser origin, so
  // no CORS headers are emitted on purpose.
  "cache-control": "no-store",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** Every error the API returns has this one shape. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
) {
  return json(
    { error: details === undefined ? { code, message } : { code, message, details } },
    API_ERROR_STATUS[code],
  );
}

/** Thrown by handlers to short-circuit with a typed error response. */
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toResponse() {
    return apiError(this.code, this.message, this.details);
  }
}

/** Read and validate a JSON request body, or throw a 400. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError("bad_request", "Request body is too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("bad_request", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError("bad_request", "Request body is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route or query parameter that must be a uuid, or a 404/400. */
export function requireUuid(value: string | undefined | null, what: string, missing: "not_found" | "bad_request" = "not_found"): string {
  if (!value || !UUID.test(value)) {
    throw new HttpError(missing, `${what} not found.`);
  }
  return value;
}
