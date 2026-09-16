import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicClient, type AnthropicOptions } from "./anthropic";
import { LlmOutputError } from "./types";

type StreamParams = Anthropic.MessageStreamParams & { output_config?: unknown; cache_control?: unknown };

const drafts = {
  drafts: [{ key: "a", title: "T", body: "B", template_name: null, labels: [], depends_on: [] }],
  reviewer_notes: null,
};

const message = (content: unknown[], stop_reason = "tool_use"): Anthropic.Message =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "m",
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
  }) as unknown as Anthropic.Message;

/** A fake SDK client whose streamed calls return the given messages in order. */
function fakeClient(responses: Anthropic.Message[]) {
  const calls: StreamParams[] = [];
  const client = {
    messages: {
      stream: vi.fn((params: StreamParams) => {
        // Snapshot: the wrapper appends to the same messages array later.
        calls.push({ ...params, messages: structuredClone(params.messages) });
        const next = responses.shift();
        return { finalMessage: async () => next };
      }),
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const options = (client: Anthropic, overrides: Partial<AnthropicOptions> = {}): AnthropicOptions => ({
  client,
  modelSelect: "select-model",
  modelDraft: "draft-model",
  jsonMode: "tool",
  caching: false,
  maxOutputTokens: 8192,
  ...overrides,
});

const draftInput = { repo: "o/r", rawIssue: "notes", routing: "", files: "", templates: "", labels: [] };

describe("createAnthropicClient, tool mode (LM Studio)", () => {
  it("forces a tool call with a JSON schema and reads its input", async () => {
    const { client, calls } = fakeClient([
      message([{ type: "tool_use", id: "t1", name: "select_files", input: { paths: ["a.ts"] } }]),
    ]);
    const result = await createAnthropicClient(options(client)).selectFiles({ repo: "o/r", rawIssue: "x", readmeExcerpt: "", routing: "", fileList: "a.ts", shown: 1, total: 1 });

    expect(result).toEqual({ paths: ["a.ts"], usage: { inputTokens: 15, outputTokens: 5 } });
    const [call] = calls;
    expect(call).toMatchObject({ model: "select-model", tool_choice: { type: "any" } });
    expect(call!.tools?.[0]).toMatchObject({ name: "select_files", input_schema: { type: "object" } });
    expect(call).not.toHaveProperty("output_config");
    expect(call).not.toHaveProperty("cache_control");
  });

  it("answers the tool call with an error result before asking for a repair", async () => {
    const first = message([{ type: "tool_use", id: "t1", name: "submit_drafts", input: drafts }]);
    const { client, calls } = fakeClient([first, message([{ type: "tool_use", id: "t2", name: "submit_drafts", input: drafts }])]);
    const conversation = await createAnthropicClient(options(client)).draftIssues(draftInput);
    await conversation.repair(["Draft \"a\": label \"x\" does not exist."]);

    const repairMessages = calls[1]!.messages;
    expect(repairMessages[1]).toMatchObject({ role: "assistant" });
    expect(repairMessages[2]).toMatchObject({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", is_error: true },
        { type: "text", text: expect.stringContaining('label "x" does not exist') },
      ],
    });
  });

  it("fails clearly when the model answers in text instead of calling the tool", async () => {
    const { client } = fakeClient([message([{ type: "text", text: "Sure! Here are your drafts..." }], "end_turn")]);
    await expect(createAnthropicClient(options(client)).draftIssues(draftInput)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it("reports truncated output", async () => {
    const { client } = fakeClient([message([], "max_tokens")]);
    await expect(createAnthropicClient(options(client)).draftIssues(draftInput)).rejects.toThrow(/ran out of output space/);
  });
});

describe("createAnthropicClient, structured mode (Anthropic API)", () => {
  it("uses output_config and caching, and parses the text block", async () => {
    const { client, calls } = fakeClient([message([{ type: "text", text: JSON.stringify(drafts) }], "end_turn")]);
    const conversation = await createAnthropicClient(options(client, { jsonMode: "structured", caching: true })).draftIssues(draftInput);

    expect(conversation.output).toEqual(drafts);
    expect(calls[0]).toMatchObject({ cache_control: { type: "ephemeral" }, output_config: { format: expect.anything() } });
    expect(calls[0]).not.toHaveProperty("tools");
  });
});

describe("describeLlmError", () => {
  it("explains LM Studio context overflow reported inside a stream", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { describeLlmError } = await import("./index");
    const body = {
      type: "error",
      error: {
        type: "api_error",
        message:
          'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (17784 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":17784,"n_ctx":8192}}',
      },
    };
    const err = new Anthropic.APIError(undefined, body, JSON.stringify(body), undefined);
    expect(describeLlmError(err)).toBe(
      "The prompt (17784 tokens) is larger than the model context window (8192 tokens). Load the model with a larger context length, and set the same context length for LM Studio in Settings.",
    );
  });

  it("uses the provider message for other API errors, and ignores non-API errors", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { describeLlmError } = await import("./index");
    const err = new Anthropic.NotFoundError(404, { type: "error", error: { type: "not_found_error", message: "model: nope" } }, "x", new Headers());
    expect(describeLlmError(err)).toBe("The AI request failed (HTTP 404): model: nope");
    expect(describeLlmError(new Error("other"))).toBeUndefined();
  });
});
