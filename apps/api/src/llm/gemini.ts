import { z } from "zod";
import { DRAFT_ISSUES_SYSTEM, draftIssuesPrompt, repairPrompt } from "../../prompts/draftIssues.v1";
import { SELECT_FILES_SYSTEM, selectFilesPrompt } from "../../prompts/selectFiles.v1";
import { draftOutputSchema } from "../pipeline/validate";
import { LlmOutputError, type LlmClient, type Usage } from "./types";

/**
 * Stage 1 calls through the Gemini API (Google AI Studio key), over plain
 * HTTPS to `models/{model}:generateContent`, so no extra SDK is needed.
 *
 * JSON is constrained with `generationConfig.responseJsonSchema`. Gemini
 * validates request fields before it checks billing, which is how the field
 * names were confirmed against the live API.
 */

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Thinking models spend part of maxOutputTokens on reasoning, so leave room. */
const SELECT_MAX_TOKENS = 8_000;

type FetchLike = typeof fetch;

/** Attempts per call for rate limits, overload (503), and network errors. */
const MAX_ATTEMPTS = 4;

/** Jittered exponential backoff before retry `attempt` (1-based): ~2 s, ~4 s, ~8 s. */
const defaultBackoff = (attempt: number) => 2_000 * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);

export interface GeminiOptions {
  apiKey: string;
  modelSelect: string;
  modelDraft: string;
  maxOutputTokens: number;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Overridable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
}

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ role: z.string().optional(), parts: z.array(z.looseObject({})).default([]) }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
});

/** A failed Gemini API call. `retryable` marks rate limits, 5xx, and network errors. */
export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

/** Out of prepaid credits or quota: waiting a minute will not help. */
const EXHAUSTED = /credits are depleted|billing|prepay|quota.*(exceeded|exhausted).*(day|month)/i;

export function describeGeminiError(err: unknown): string | undefined {
  if (!(err instanceof GeminiApiError)) return undefined;
  if (err.status === 429 && EXHAUSTED.test(err.message)) {
    return "The Google API key has no credits or quota left. Add credits in Google AI Studio (https://ai.studio/projects), then retry the run.";
  }
  if (err.status === 400 && /token/i.test(err.message) && /exceed|too (long|large|many)|limit/i.test(err.message)) {
    return `The prompt is larger than the model context window: ${err.message.slice(0, 300)}`;
  }
  if (err.status === 400 && /api key/i.test(err.message)) {
    return "The Google API key was rejected. Check GOOGLE_API_KEY.";
  }
  if (err.status === 403) return `The Google API key is not allowed to use this model: ${err.message.slice(0, 300)}`;
  if (err.status === 404) return `Gemini model not found: ${err.message.slice(0, 300)}`;
  if (err.status === 0) return `Could not reach the Gemini API: ${err.message}`;
  return `The AI request failed (HTTP ${err.status}): ${err.message.slice(0, 300)}`;
}

export const isRetryableGeminiError = (err: unknown) => err instanceof GeminiApiError && err.retryable;

function usageOf(body: z.infer<typeof responseSchema>): Usage {
  const u = body.usageMetadata ?? {};
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

/** Gemini's JSON Schema subset: drop the dialect marker the converter adds. */
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function createGeminiClient(options: GeminiOptions): LlmClient {
  const fetchImpl = options.fetch ?? fetch;
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const selectOutputTokens = Math.min(SELECT_MAX_TOKENS, options.maxOutputTokens);

  async function generate<T>(call: {
    model: string;
    system: string;
    contents: Content[];
    schema: z.ZodType<T>;
    maxTokens: number;
    what: string;
  }): Promise<{ output: T; content: Content; usage: Usage }> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: call.system }] },
      contents: call.contents,
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaFor(call.schema),
        maxOutputTokens: call.maxTokens,
      },
    });

    // Retry overload and rate limits here, as the Anthropic SDK does for its
    // client: "high demand" 503s from Gemini are common and short-lived.
    let raw: unknown;
    for (let attempt = 1; ; attempt++) {
      let error: GeminiApiError;
      try {
        const res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(call.model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        raw = await res.json().catch(() => undefined);
        if (res.ok) break;
        const message =
          (raw as { error?: { message?: string } } | undefined)?.error?.message ?? `Gemini returned ${res.status}`;
        const retryable = res.status >= 500 || (res.status === 429 && !EXHAUSTED.test(message));
        error = new GeminiApiError(message, res.status, retryable);
      } catch (err) {
        if (err instanceof GeminiApiError) throw err;
        error = new GeminiApiError(err instanceof Error ? err.name : "network error", 0, true);
      }
      if (!error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }

    const parsedBody = responseSchema.safeParse(raw);
    if (!parsedBody.success) throw new LlmOutputError(`The Gemini response to "${call.what}" had an unexpected shape.`);
    const response = parsedBody.data;

    if (response.promptFeedback?.blockReason) {
      throw new LlmOutputError(`The model declined to ${call.what} (${response.promptFeedback.blockReason}).`);
    }
    const candidate = response.candidates?.[0];
    if (!candidate?.content) throw new LlmOutputError(`The model returned nothing for "${call.what}".`);
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new LlmOutputError(`The model ran out of output space while trying to ${call.what}. Try shorter notes or split them.`);
    }
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      throw new LlmOutputError(`The model stopped before finishing "${call.what}" (${candidate.finishReason}).`);
    }

    const parts = candidate.content.parts as Part[];
    // Thought summaries are not part of the answer.
    const text = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmOutputError(`The response to "${call.what}" was not valid JSON.`);
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) throw new LlmOutputError(`The response to "${call.what}" did not match the expected shape.`);

    // Returned verbatim (thought signatures included) when the turn is replayed.
    return { output: parsed.data, content: { role: "model", parts }, usage: usageOf(response) };
  }

  return {
    limits: { selectOutputTokens, draftOutputTokens: options.maxOutputTokens },

    async selectFiles(input) {
      const { output, usage } = await generate({
        model: options.modelSelect,
        system: SELECT_FILES_SYSTEM,
        contents: [{ role: "user", parts: [{ text: selectFilesPrompt(input) }] }],
        schema: z.object({ paths: z.array(z.string()) }),
        maxTokens: selectOutputTokens,
        what: "select files",
      });
      return { paths: output.paths, usage };
    },

    async draftIssues(input) {
      const contents: Content[] = [{ role: "user", parts: [{ text: draftIssuesPrompt(input) }] }];
      const draftCall = () =>
        generate({
          model: options.modelDraft,
          system: DRAFT_ISSUES_SYSTEM,
          contents,
          schema: draftOutputSchema,
          maxTokens: options.maxOutputTokens,
          what: "draft the issues",
        });

      const first = await draftCall();
      return {
        output: first.output,
        usage: first.usage,
        async repair(errors) {
          contents.push(first.content, { role: "user", parts: [{ text: repairPrompt(errors) }] });
          const second = await draftCall();
          return { output: second.output, usage: second.usage };
        },
      };
    },
  };
}
