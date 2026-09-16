import type { AiModel, AiProvider } from "@issue-pipeline/shared";
import { z } from "zod";
import { lmStudioRoot } from "./index";
import { OPENAI_COMPATIBLE_PROVIDERS } from "./openai";

/**
 * Live model lists for the Settings model pickers, fetched with the user's
 * (or the team's) key. Each hosted provider's list endpoint is fixed. LM
 * Studio's is the URL the user saved in Settings, which is only used while the
 * server runs locally (requireAiProvider refuses it when deployed).
 */

type FetchLike = typeof fetch;

const TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;

export class ModelListError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

const openAiList = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      // Venice describes each model; a model known not to accept a response schema is left out.
      model_spec: z
        .looseObject({
          name: z.string().optional(),
          capabilities: z.looseObject({ supportsResponseSchema: z.boolean().optional() }).optional(),
        })
        .optional(),
    }),
  ),
});
const anthropicList = z.object({ data: z.array(z.looseObject({ id: z.string(), display_name: z.string().optional() })) });
const geminiList = z.object({
  models: z
    .array(
      z.looseObject({
        name: z.string(),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

/** OpenAI's list includes embeddings, audio, image, and moderation models that cannot draft. */
const OPENAI_NON_CHAT = /embedding|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|search|babbage|davinci|sora/i;

async function getJson(url: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ModelListError(`Could not reach the provider (${err instanceof Error ? err.name : "network error"}).`, 0);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = (body as { error?: unknown } | undefined)?.error;
    const message =
      typeof error === "string"
        ? error
        : typeof (error as { message?: unknown } | undefined)?.message === "string"
          ? (error as { message: string }).message
          : `The provider returned ${res.status}`;
    throw new ModelListError(message.slice(0, 300), res.status);
  }
  return body;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ModelListError("The provider's model list had an unexpected shape.", 502);
  return parsed.data;
}

export async function listProviderModels(
  provider: AiProvider,
  apiKey: string,
  { baseUrl, fetchImpl = fetch }: { baseUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<AiModel[]> {
  let models: AiModel[];
  switch (provider) {
    case "anthropic": {
      const body = await getJson(
        "https://api.anthropic.com/v1/models?limit=1000",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        fetchImpl,
      );
      models = parse(anthropicList, body).data.map((m) => ({ id: m.id, name: m.display_name ?? null }));
      break;
    }
    case "gemini": {
      const body = await getJson(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        { "x-goog-api-key": apiKey },
        fetchImpl,
      );
      models = parse(geminiList, body)
        .models.filter((m) => m.supportedGenerationMethods?.includes("generateContent") ?? true)
        .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName ?? null }));
      break;
    }
    case "grok":
    case "openai":
    case "venice": {
      const base = OPENAI_COMPATIBLE_PROVIDERS[provider].baseUrl;
      const url = provider === "venice" ? `${base}/models?type=text` : `${base}/models`;
      const body = await getJson(url, { authorization: `Bearer ${apiKey}` }, fetchImpl);
      models = parse(openAiList, body)
        .data.filter((m) => !(provider === "openai" && OPENAI_NON_CHAT.test(m.id)))
        .filter((m) => m.model_spec?.capabilities?.supportsResponseSchema !== false)
        .map((m) => ({ id: m.id, name: m.model_spec?.name ?? null }));
      break;
    }
    case "lmstudio": {
      // LM Studio's OpenAI-compatible list; embedding models cannot draft.
      const root = lmStudioRoot(baseUrl ?? "http://localhost:1234");
      const body = await getJson(`${root}/v1/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, fetchImpl);
      models = parse(openAiList, body)
        .data.filter((m) => !/embed/i.test(m.id))
        .map((m) => ({ id: m.id, name: null }));
      break;
    }
  }
  return models.sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}
