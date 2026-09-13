import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient, describeAnthropicError, isRetryableAnthropicError } from "./anthropic";
import { createGeminiClient, describeGeminiError, isRetryableGeminiError } from "./gemini";
import { LlmOutputError, type LlmClient } from "./types";

export * from "./types";

/**
 * Model provider selection, from environment variables only: API keys never
 * pass through the UI, and switching is a one-line .env change plus a
 * restart (or a Netlify env change plus a redeploy).
 *
 *   LLM_PROVIDER=anthropic  ANTHROPIC_API_KEY, ANTHROPIC_MODEL_SELECT, ANTHROPIC_MODEL_DRAFT
 *   LLM_PROVIDER=gemini     GOOGLE_API_KEY, GEMINI_MODEL_SELECT, GEMINI_MODEL_DRAFT
 *   LLM_PROVIDER=lmstudio   LMSTUDIO_BASE_URL, LMSTUDIO_MODEL_SELECT, LMSTUDIO_MODEL_DRAFT,
 *                           LMSTUDIO_CONTEXT_TOKENS   (local development only)
 *
 * LLM_MAX_OUTPUT_TOKENS optionally caps the drafting output for any provider.
 */
export const LLM_PROVIDERS = ["anthropic", "gemini", "lmstudio"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function llmProviderFromEnv(): LlmProvider {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(", ")}; got "${provider}"`);
  }
  return provider as LlmProvider;
}

const DEFAULT_MODELS: Record<LlmProvider, { select: string; draft: string }> = {
  anthropic: { select: "claude-haiku-4-5-20251001", draft: "claude-sonnet-5" },
  gemini: { select: "gemini-3.5-flash-lite", draft: "gemini-3.8-flash" },
  // Whatever is loaded in LM Studio; there is no sensible default id.
  lmstudio: { select: "", draft: "" },
};

const ENV_PREFIX: Record<LlmProvider, string> = { anthropic: "ANTHROPIC", gemini: "GEMINI", lmstudio: "LMSTUDIO" };

/** The active provider's model ids, as recorded on each run ("provider/model"). */
export function modelsFromEnv(provider = llmProviderFromEnv()) {
  const prefix = ENV_PREFIX[provider];
  const select = process.env[`${prefix}_MODEL_SELECT`] || DEFAULT_MODELS[provider].select;
  const draft = process.env[`${prefix}_MODEL_DRAFT`] || DEFAULT_MODELS[provider].draft;
  if (!select || !draft) {
    throw new Error(`Set ${prefix}_MODEL_SELECT and ${prefix}_MODEL_DRAFT`);
  }
  return { select, draft, recorded: { select: `${provider}/${select}`, draft: `${provider}/${draft}` } };
}

function positiveIntFromEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function llmClientFromEnv(): LlmClient {
  const provider = llmProviderFromEnv();
  const models = modelsFromEnv(provider);
  const maxOutput = positiveIntFromEnv("LLM_MAX_OUTPUT_TOKENS");

  switch (provider) {
    case "anthropic":
      return createAnthropicClient({
        client: new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") }),
        modelSelect: models.select,
        modelDraft: models.draft,
        jsonMode: "structured",
        caching: true,
        maxOutputTokens: maxOutput ?? 64_000,
      });

    case "gemini":
      return createGeminiClient({
        apiKey: requireEnv("GOOGLE_API_KEY"),
        modelSelect: models.select,
        modelDraft: models.draft,
        maxOutputTokens: maxOutput ?? 32_000,
      });

    case "lmstudio":
      // A model on a developer's machine is unreachable from deployed functions.
      if (process.env.CONTEXT && process.env.CONTEXT !== "dev") {
        throw new Error("LLM_PROVIDER=lmstudio is for local development only");
      }
      return createAnthropicClient({
        // LM Studio ignores the key unless "Require Authentication" is enabled.
        client: new Anthropic({
          baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234",
          apiKey: process.env.LMSTUDIO_API_KEY || "lm-studio",
          timeout: 15 * 60 * 1000,
        }),
        modelSelect: models.select,
        modelDraft: models.draft,
        jsonMode: "tool",
        caching: false,
        maxOutputTokens: maxOutput ?? positiveIntFromEnv("LMSTUDIO_MAX_OUTPUT_TOKENS") ?? 4_096,
        contextTokens: positiveIntFromEnv("LMSTUDIO_CONTEXT_TOKENS") ?? 8_192,
      });
  }
}

/** Transient provider trouble (rate limits, overload, 5xx, network): safe to retry later. */
export const isRetryableLlmError = (err: unknown) => isRetryableAnthropicError(err) || isRetryableGeminiError(err);

/** A run-error message for any provider's failure, or undefined for non-AI errors. */
export function describeLlmError(err: unknown): string | undefined {
  if (err instanceof LlmOutputError) return err.message;
  return describeAnthropicError(err) ?? describeGeminiError(err);
}
