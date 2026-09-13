import type { DraftIssuesInput } from "../../prompts/draftIssues.v1";
import type { SelectFilesInput } from "../../prompts/selectFiles.v1";
import type { DraftOutput } from "../pipeline/validate";

/** What the drafting pipeline needs from any model provider. */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmLimits {
  /** The model's context window, when it is small enough that prompts must be budgeted. */
  contextTokens?: number;
  selectOutputTokens: number;
  draftOutputTokens: number;
}

export interface LlmClient {
  readonly limits: LlmLimits;
  selectFiles(input: SelectFilesInput): Promise<{ paths: string[]; usage: Usage }>;
  draftIssues(input: DraftIssuesInput): Promise<DraftConversation>;
}

/** A drafting exchange that can be continued with one repair turn. */
export interface DraftConversation {
  output: DraftOutput;
  usage: Usage;
  repair(errors: string[]): Promise<{ output: DraftOutput; usage: Usage }>;
}

/** A model failure that retrying the same request will not fix. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
