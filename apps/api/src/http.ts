import { API_ERROR_STATUS, type ApiErrorCode } from "@issue-pipeline/shared";

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
