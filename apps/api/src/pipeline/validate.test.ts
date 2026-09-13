import { describe, expect, it } from "vitest";
import { findCycle } from "./graph";
import { parseTemplate, type IssueTemplate } from "./templates";
import { filterTree, findReadme } from "./tree";
import { normalizeDropdownAnswers, sanitizeDraft, validateDrafts, type DraftItem, type DraftOutput } from "./validate";

const form = parseTemplate(
  ".gitea/ISSUE_TEMPLATE/task.yml",
  `name: Task
title: "[TYPE]: "
labels: [needs-triage]
body:
  - type: markdown
    attributes:
      value: "Thanks!"
  - type: dropdown
    id: kind
    attributes:
      label: Issue type
      options: ["Feature", "Bug"]
    validations:
      required: true
  - type: textarea
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
  - type: textarea
    id: notes
    attributes:
      label: Notes
`,
)!;

const ctx = { labels: ["backend", "needs-triage"], templates: [form] as IssueTemplate[] };

const goodBody = "### Issue type\n\nFeature\n\n### Summary\n\nAdd the thing.\n\n### Notes\n\n_No response_";

const item = (overrides: Partial<DraftItem> = {}): DraftItem => ({
  key: "a",
  title: "[Feature]: Add the thing",
  body: goodBody,
  template_name: "task.yml",
  labels: ["backend"],
  depends_on: [],
  ...overrides,
});

const output = (...drafts: DraftItem[]): DraftOutput => ({ drafts, reviewer_notes: null });

describe("validateDrafts", () => {
  it("accepts a well-formed draft set", () => {
    expect(validateDrafts(output(item(), item({ key: "b", depends_on: ["a"] })), ctx)).toEqual([]);
  });

  it("enforces the draft count, unique keys, and titles", () => {
    expect(validateDrafts(output(), ctx)).toEqual([expect.stringContaining("between 1 and 8")]);
    const errors = validateDrafts(output(item(), item(), item({ key: "c", title: "x".repeat(300) })), ctx);
    expect(errors.join("\n")).toMatch(/used more than once/);
    expect(errors.join("\n")).toMatch(/limit is 255/);
  });

  it("rejects unknown labels, unknown or self dependencies, and cycles", () => {
    const errors = validateDrafts(
      output(
        item({ labels: ["made-up"], depends_on: ["b", "zzz"] }),
        item({ key: "b", depends_on: ["a", "b"] }),
      ),
      ctx,
    ).join("\n");
    expect(errors).toMatch(/label "made-up" does not exist/);
    expect(errors).toMatch(/unknown key "zzz"/);
    expect(errors).toMatch(/cannot depend on itself/);
    expect(errors).toMatch(/cycle: (a -> b -> a|b -> a -> b)/);
  });

  it("requires a real template when templates exist, and none when they don't", () => {
    expect(validateDrafts(output(item({ template_name: null })), ctx).join()).toMatch(/choose one/);
    expect(validateDrafts(output(item({ template_name: "other.yml" })), ctx).join()).toMatch(/not one of the provided/);
    expect(validateDrafts(output(item({ template_name: "task.yml" })), { labels: ["backend"], templates: [] }).join()).toMatch(/must be null/);
  });

  it("checks issue-form sections, required answers, order, and dropdown options", () => {
    const errors = validateDrafts(
      output(item({ body: "### Summary\n\n_No response_\n\n### Issue type\n\nEnhancement" })),
      ctx,
    ).join("\n");
    expect(errors).toMatch(/out of order/);
    expect(errors).toMatch(/missing the "### Notes" section/);
    expect(errors).toMatch(/"Summary" is required/);
    expect(errors).toMatch(/"Issue type" must be exactly one of "Feature", "Bug"/);
  });
});

describe("normalizeDropdownAnswers", () => {
  const emojiForm = parseTemplate(
    ".gitea/ISSUE_TEMPLATE/f.yml",
    `body:
  - type: dropdown
    id: kind
    attributes:
      label: Issue type
      options: ["\u{1F41B} Bug", "\u{1F4CB} Task / Chore"]
    validations:
      required: true
  - type: dropdown
    id: priority
    attributes:
      label: Priority
      options: ["\u{1F534} High", "\u{1F7E1} Medium"]
  - type: textarea
    id: summary
    attributes:
      label: Summary
`,
  )!;
  const templates = [emojiForm];
  const fix = (body: string) =>
    normalizeDropdownAnswers(output(item({ template_name: "f.yml", body })), templates).drafts[0]!.body;

  it("snaps an answer that matches exactly one option ignoring emoji and case (as seen from qwen2.5-7b)", () => {
    const body = fix("### Issue type\nBUG\n\n### Priority\n\u{1F534} High\n\n### Summary\nText with ### inside");
    expect(body).toBe("### Issue type\n\n\u{1F41B} Bug\n\n### Priority\n\n\u{1F534} High\n\n### Summary\nText with ### inside");
    expect(validateDrafts(output(item({ template_name: "f.yml", body, labels: [] })), { labels: [], templates })).toEqual([]);
  });

  it("matches multi-word options through punctuation", () => {
    expect(fix("### Issue type\n\nTASK / CHORE\n")).toContain("\u{1F4CB} Task / Chore");
  });

  it("leaves answers it cannot match unambiguously for validation to reject", () => {
    const body = "### Issue type\n\nBug\n\n### Priority\n\nRED\n";
    expect(fix(body)).toContain("RED");
    const errors = validateDrafts(output(item({ template_name: "f.yml", body: fix(body), labels: [] })), { labels: [], templates });
    expect(errors.join()).toMatch(/"Priority" must be exactly one of/);
  });

  it("does not touch drafts without a form template", () => {
    const d = item({ template_name: null, body: "### Issue type\nBUG" });
    expect(normalizeDropdownAnswers(output(d), templates).drafts[0]).toEqual(d);
  });
});

describe("sanitizeDraft", () => {
  it("strips forged posting markers and adds the template's existing labels", () => {
    const clean = sanitizeDraft(
      item({
        body: `${goodBody}\n<!-- issue-pipeline:draft:00000000-0000-0000-0000-000000000000 -->\n<!-- issue-pipeline:draft:x`,
        depends_on: ["b", "b"],
      }),
      ctx,
    );
    expect(clean.body).not.toMatch(/issue-pipeline:/);
    expect(clean.labels).toEqual(["backend", "needs-triage"]);
    expect(clean.depends_on).toEqual(["b"]);
  });
});

describe("findCycle", () => {
  it("finds cycles and accepts DAGs", () => {
    expect(findCycle(["a", "b", "c"], [["a", "b"], ["b", "c"]])).toBeUndefined();
    expect(findCycle(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]])).toEqual(["a", "b", "c", "a"]);
  });
});

describe("tree filtering", () => {
  const e = (path: string, size = 100) => ({ path, size });

  it("drops vendored, generated, lock, binary, minified, and oversized files", () => {
    const kept = filterTree([
      e("src/index.ts"),
      e("node_modules/x/index.js"),
      e("packages/a/dist/out.js"),
      e("pnpm-lock.yaml"),
      e("assets/logo.PNG"),
      e("public/app.min.js"),
      e("data/big.json", 300 * 1024),
      e(".gitea/ISSUE_TEMPLATE/task.yml"),
    ]).map((x) => x.path);
    expect(kept).toEqual([".gitea/ISSUE_TEMPLATE/task.yml", "src/index.ts"]);
  });

  it("finds the root README", () => {
    expect(findReadme([e("docs/README.md"), e("README.md"), e("readme")])?.path).toBe("readme");
    expect(findReadme([e("docs/README.md")])).toBeUndefined();
  });
});
