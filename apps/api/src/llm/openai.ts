import { z } from "zod";
import { DRAFT_ISSUES_SYSTEM, draftIssuesPrompt, repairPrompt } from "../../prompts/draftIssues.v1";
import { SELECT_FILES_SYSTEM, selectFilesPrompt } from "../../prompts/selectFiles.v1";
import { draftOutputSchema } from "../pipeline/validate";
import { LlmOutputError, type LlmClient, type Usage } from "./types";

/**
 * Stage 1 calls through OpenAI-style chat completions, over plain HTTPS: the
 * OpenAI API itself, xAI (Grok), and Venice all serve this shape.
 *
 * JSON is requested with `response_format: {type: "json_schema"}`, non-strict
 * (strict mode rejects optional fields in the draft schema); the output is
 * validated with zod either way and gets one repair turn, as with the other
 * providers. Base URLs are fixed per provider, never taken from user input.
 */

export const OPENAI_COMPATIBLE_PROVIDERS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", maxTokensField: "max_completion_tokens" },
  // xAI documents max_tokens for chat completions.
  grok: { label: "xAI", baseUrl: "https://api.x.ai/v1", maxTokensField: "max_tokens" },
  venice: { label: "Venice", baseUrl: "https://api.venice.ai/api/v1", maxTokensField: "max_completion_tokens" },
} as const;

export type OpenAiCompatibleProvider = keyof typeof OPENAI_COMPATIBLE_PROVIDERS;

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Reasoning models spend part of the output cap on thinking, so leave room. */
const SELECT_MAX_TOKENS = 8_000;
const MAX_ATTEMPTS = 4;

const defaultBackoff = (attempt: number) => 2_000 * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);

type FetchLike = typeof fetch;

export interface OpenAiCompatibleOptions {
  provider: OpenAiCompatibleProvider;
  apiKey: string;
  modelSelect: string;
  modelDraft: string;
  maxOutputTokens: number;
  fetch?: FetchLike;
  /** Overridable so tests don't sleep. */
  backoffMs?: (attempt: number) => number;
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

/** A failed chat-completions call. `retryable` marks rate limits, 5xx, and network errors. */
export class OpenAiCompatibleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly provider: OpenAiCompatibleProvider,
  ) {
    super(message);
    this.name = "OpenAiCompatibleError";
  }
}

/** Out of credits or quota: waiting a minute will not help. */
const EXHAUSTED = /insufficient_quota|exceeded your current quota|credits|billing|balance/i;

/** OpenAI nests `{error: {message, code}}`; xAI and Venice sometimes send `{error: "text"}`. */
function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { message, code } = error as { message?: unknown; code?: unknown };
    if (typeof message === "string") return typeof code === "string" ? `${message} (${code})` : message;
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

export function describeOpenAiCompatibleError(err: unknown): string | undefined {
  if (!(err instanceof OpenAiCompatibleError)) return undefined;
  const label = OPENAI_COMPATIBLE_PROVIDERS[err.provider].label;
  const detail = err.message.slice(0, 300);
  if (err.status === 401) return `The ${label} API key was rejected. Check the key in Settings.`;
  if (err.status === 402 || (err.status === 429 && EXHAUSTED.test(err.message))) {
    return `The ${label} account has no credits or quota left: ${detail}`;
  }
  if (err.status === 403) return `The ${label} API key is not allowed to use this model: ${detail}`;
  if (err.status === 404) return `${label} model not found: ${detail}`;
  if (err.status === 400 && /context|too long|maximum.*tokens|token limit/i.test(err.message)) {
    return `The prompt is larger than the model context window: ${detail}`;
  }
  if (err.status === 400 && /response_format|json_schema|structured/i.test(err.message)) {
    return `This ${label} model does not accept structured output. Choose another model in Settings: ${detail}`;
  }
  if (err.status === 0) return `Could not reach the ${label} API: ${err.message}`;
  return `The AI request failed (HTTP ${err.status}): ${detail}`;
}

export const isRetryableOpenAiCompatibleError = (err: unknown) => err instanceof OpenAiCompatibleError && err.retryable;

/** Some models wrap JSON in a Markdown fence even when asked for a schema. */
function unfence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : text;
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): LlmClient {
  const provider = OPENAI_COMPATIBLE_PROVIDERS[options.provider];
  const fetchImpl = options.fetch ?? fetch;
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const selectOutputTokens = Math.min(SELECT_MAX_TOKENS, options.maxOutputTokens);

  async function complete<T>(call: {
    model: string;
    messages: Message[];
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens: number;
    what: string;
  }): Promise<{ output: T; text: string; usage: Usage }> {
    const body = JSON.stringify({
      model: call.model,
      messages: call.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: call.schemaName, schema: jsonSchemaFor(call.schema), strict: false },
      },
      [provider.maxTokensField]: call.maxTokens,
      // Venice prepends its own system prompt unless told not to.
      ...(options.provider === "venice" ? { venice_parameters: { include_venice_system_prompt: false } } : {}),
    });

    let raw: unknown;
    for (let attempt = 1; ; attempt++) {
      let error: OpenAiCompatibleError;
      try {
        const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        raw = await res.json().catch(() => undefined);
        if (res.ok) break;
        const message = errorMessage(raw, `${provider.label} returned ${res.status}`);
        const retryable = res.status >= 500 || (res.status === 429 && !EXHAUSTED.test(message));
        error = new OpenAiCompatibleError(message, res.status, retryable, options.provider);
      } catch (err) {
        if (err instanceof OpenAiCompatibleError) throw err;
        error = new OpenAiCompatibleError(err instanceof Error ? err.name : "network error", 0, true, options.provider);
      }
      if (!error.retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }

    const parsedBody = responseSchema.safeParse(raw);
    if (!parsedBody.success) {
      throw new LlmOutputError(`The ${provider.label} response to "${call.what}" had an unexpected shape.`);
    }
    const response = parsedBody.data;
    const choice = response.choices[0];
    if (choice?.message?.refusal) throw new LlmOutputError(`The model declined to ${call.what}.`);
    if (choice?.finish_reason === "length") {
      throw new LlmOutputError(`The model ran out of output space while trying to ${call.what}. Try shorter notes or split them.`);
    }
    if (choice?.finish_reason === "content_filter") {
      throw new LlmOutputError(`The model declined to ${call.what} (content filter).`);
    }
    const text = choice?.message?.content;
    if (!text) throw new LlmOutputError(`The model returned nothing for "${call.what}".`);

    let json: unknown;
    try {
      json = JSON.parse(unfence(text));
    } catch {
      throw new LlmOutputError(`The response to "${call.what}" was not valid JSON.`);
    }
    const parsed = call.schema.safeParse(json);
    if (!parsed.success) throw new LlmOutputError(`The response to "${call.what}" did not match the expected shape.`);

    return {
      output: parsed.data,
      text,
      usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
    };
  }

  return {
    limits: { selectOutputTokens, draftOutputTokens: options.maxOutputTokens },

    async selectFiles(input) {
      const { output, usage } = await complete({
        model: options.modelSelect,
        messages: [
          { role: "system", content: SELECT_FILES_SYSTEM },
          { role: "user", content: selectFilesPrompt(input) },
        ],
        schema: z.object({ paths: z.array(z.string()) }),
        schemaName: "select_files",
        maxTokens: selectOutputTokens,
        what: "select files",
      });
      return { paths: output.paths, usage };
    },

    async draftIssues(input) {
      const messages: Message[] = [
        { role: "system", content: DRAFT_ISSUES_SYSTEM },
        { role: "user", content: draftIssuesPrompt(input) },
      ];
      const draftCall = () =>
        complete({
          model: options.modelDraft,
          messages,
          schema: draftOutputSchema,
          schemaName: "issue_drafts",
          maxTokens: options.maxOutputTokens,
          what: "draft the issues",
        });

      const first = await draftCall();
      return {
        output: first.output,
        usage: first.usage,
        async repair(errors) {
          messages.push({ role: "assistant", content: first.text }, { role: "user", content: repairPrompt(errors) });
          const second = await draftCall();
          return { output: second.output, usage: second.usage };
        },
      };
    },
  };
}
