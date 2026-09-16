import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DRAFT_ISSUES_SYSTEM, draftIssuesPrompt, repairPrompt } from "../../prompts/draftIssues.v1";
import { SELECT_FILES_SYSTEM, selectFilesPrompt } from "../../prompts/selectFiles.v1";
import { draftOutputSchema } from "../pipeline/validate";
import { LlmOutputError, type LlmClient, type Usage } from "./types";

/**
 * Stage 1 calls through the Anthropic SDK: the Anthropic API itself, or LM
 * Studio's Anthropic-compatible endpoint for local development.
 *
 * Two JSON modes, one SDK:
 * - "structured" (the Anthropic API): output constrained by structured outputs
 *   (`output_config.format`), with the repository context prompt-cached.
 * - "tool" (LM Studio's Anthropic-compatible endpoint, for local development):
 *   the JSON arrives as the input of a forced tool call, and no cache_control
 *   is sent, since neither structured outputs nor caching are documented there.
 */

/** Transient API trouble: rate limits, overload, 5xx, network. Safe to retry later. */
export function isRetryableAnthropicError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  );
}

/**
 * A run-error message for an AI failure. Errors reported inside a stream carry
 * no HTTP status, so the provider's own message is extracted from the body.
 */
export function describeAnthropicError(err: unknown): string | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined;

  const body = err.error as { error?: { message?: unknown } } | undefined;
  let detail = typeof body?.error?.message === "string" ? body.error.message : err.message;
  // LM Studio nests its engine error as JSON inside the message.
  const nested = detail.match(/\{"error":\{[\s\S]*\}\}/);
  if (nested) {
    try {
      const inner = JSON.parse(nested[0]) as { error?: { message?: string; n_prompt_tokens?: number; n_ctx?: number } };
      if (inner.error?.n_prompt_tokens && inner.error.n_ctx) {
        return `The prompt (${inner.error.n_prompt_tokens} tokens) is larger than the model context window (${inner.error.n_ctx} tokens). Load the model with a larger context length, and set the same context length for LM Studio in Settings.`;
      }
      if (inner.error?.message) detail = inner.error.message;
    } catch {
      // Keep the outer message.
    }
  }
  if (/context (size|length|window)|prompt is too long|too many tokens/i.test(detail)) {
    return `The prompt is larger than the model context window: ${detail.slice(0, 300)}`;
  }
  const status = err.status ? ` (HTTP ${err.status})` : "";
  return `The AI request failed${status}: ${detail.slice(0, 300)}`;
}

export type JsonMode = "structured" | "tool";

export interface AnthropicOptions {
  client: Anthropic;
  modelSelect: string;
  modelDraft: string;
  jsonMode: JsonMode;
  /** Send cache_control on the drafting call. */
  caching: boolean;
  maxOutputTokens: number;
  /** Set for small-context models so the pipeline budgets its prompts. */
  contextTokens?: number;
}

const selectSchema = z.object({ paths: z.array(z.string()) });

/** A list of up to 20 paths needs well under this. */
const SELECT_MAX_TOKENS = 2_000;

function usageOf(message: Anthropic.Message): Usage {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

function checkStop(message: Anthropic.Message, what: string) {
  if (message.stop_reason === "refusal") {
    throw new LlmOutputError(`The model declined to ${what}.`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new LlmOutputError(`The model ran out of output space while trying to ${what}. Try shorter notes or split them.`);
  }
}

interface JsonCall<T> {
  model: string;
  maxTokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription: string;
  what: string;
}

/** One model call that returns schema-shaped JSON, in whichever mode the provider supports. */
async function callJson<T>(options: AnthropicOptions, call: JsonCall<T>): Promise<{ message: Anthropic.Message; output: T }> {
  const base = {
    model: call.model,
    max_tokens: call.maxTokens,
    system: call.system,
    messages: call.messages,
    ...(options.caching ? { cache_control: { type: "ephemeral" as const } } : {}),
  };

  // Streamed: drafting output can be long, and local models can be slow.
  const message =
    options.jsonMode === "structured"
      ? await options.client.messages.stream({ ...base, output_config: { format: zodOutputFormat(call.schema) } }).finalMessage()
      : await options.client.messages
          .stream({
            ...base,
            tools: [
              {
                name: call.toolName,
                description: call.toolDescription,
                input_schema: z.toJSONSchema(call.schema) as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: "any" },
          })
          .finalMessage();
  checkStop(message, call.what);

  let json: unknown;
  if (options.jsonMode === "structured") {
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmOutputError(`The response to "${call.what}" was not valid JSON.`);
    }
  } else {
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === call.toolName);
    if (!toolUse) {
      throw new LlmOutputError(`The model did not return structured output for "${call.what}".`);
    }
    json = toolUse.input;
  }

  const parsed = call.schema.safeParse(json);
  if (!parsed.success) {
    throw new LlmOutputError(`The response to "${call.what}" did not match the expected shape.`);
  }
  return { message, output: parsed.data };
}

export function createAnthropicClient(options: AnthropicOptions): LlmClient {
  const selectOutputTokens = Math.min(SELECT_MAX_TOKENS, options.maxOutputTokens);
  return {
    limits: {
      contextTokens: options.contextTokens,
      selectOutputTokens,
      draftOutputTokens: options.maxOutputTokens,
    },

    async selectFiles(input) {
      const { message, output } = await callJson(options, {
        model: options.modelSelect,
        maxTokens: selectOutputTokens,
        system: SELECT_FILES_SYSTEM,
        messages: [{ role: "user", content: selectFilesPrompt(input) }],
        schema: selectSchema,
        toolName: "select_files",
        toolDescription: "Report the repository file paths to read before drafting.",
        what: "select files",
      });
      return { paths: output.paths, usage: usageOf(message) };
    },

    async draftIssues(input) {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: draftIssuesPrompt(input) }];
      const draftCall = () =>
        callJson(options, {
          model: options.modelDraft,
          maxTokens: options.maxOutputTokens,
          system: DRAFT_ISSUES_SYSTEM,
          messages,
          schema: draftOutputSchema,
          toolName: "submit_drafts",
          toolDescription: "Submit the issue drafts.",
          what: "draft the issues",
        });

      const first = await draftCall();

      return {
        output: first.output,
        usage: usageOf(first.message),
        async repair(errors) {
          // Append-only, so the cached prefix (system + context) stays intact.
          messages.push({ role: "assistant", content: first.message.content });
          const toolUse = first.message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          messages.push({
            role: "user",
            content: toolUse
              ? [
                  // A tool call must be answered before anything else.
                  { type: "tool_result", tool_use_id: toolUse.id, content: "Validation failed.", is_error: true },
                  { type: "text", text: repairPrompt(errors) },
                ]
              : repairPrompt(errors),
          });
          const second = await draftCall();
          return { output: second.output, usage: usageOf(second.message) };
        },
      };
    },
  };
}
