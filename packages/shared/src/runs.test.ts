import { describe, expect, it } from "vitest";
import { runSummarySchema } from "./runs.js";

describe("runSummarySchema", () => {
  it("accepts draft counts for only the statuses a run has", () => {
    const row = {
      id: "2067cdb0-74f0-4fed-ba8a-99ee9b3f8c12",
      status: "done",
      error: null,
      attempts: 2,
      repo: { id: "2067cdb0-74f0-4fed-ba8a-99ee9b3f8c13", owner: "TrueRoster", name: "frontend" },
      author: { username: "kayela", display_name: null },
      excerpt: "The link color for the navbar...",
      drafts: { draft: 1 },
      created_at: "2026-09-12T22:58:03.584Z",
      started_at: null,
      finished_at: null,
    };
    expect(runSummarySchema.safeParse(row).success).toBe(true);
    expect(runSummarySchema.safeParse({ ...row, drafts: {} }).success).toBe(true);
    expect(runSummarySchema.safeParse({ ...row, drafts: { nonsense: 1 } }).success).toBe(false);
  });
});
