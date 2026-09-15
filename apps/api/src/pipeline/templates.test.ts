import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GITHUB_TEMPLATE_DIRS,
  NO_RESPONSE,
  appTemplateFile,
  appTemplateFromSnapshot,
  checkTemplate,
  describeTemplate,
  findTemplatePaths,
  parseTemplate,
} from "./templates";

// The real TrueRoster issue form, committed at the repository root.
const featureTask = readFileSync(new URL("../../../../feature-task.yml", import.meta.url), "utf8");

describe("findTemplatePaths", () => {
  const entry = (path: string) => ({ path, size: 10 });

  it("uses the first template directory Gitea would, skipping config and nested files", () => {
    const tree = [
      entry(".github/ISSUE_TEMPLATE/bug.md"),
      entry(".gitea/ISSUE_TEMPLATE/feature.yml"),
      entry(".gitea/ISSUE_TEMPLATE/config.yml"),
      entry(".gitea/ISSUE_TEMPLATE/nested/x.md"),
      entry(".gitea/ISSUE_TEMPLATE/notes.txt"),
    ];
    expect(findTemplatePaths(tree)).toEqual([".gitea/ISSUE_TEMPLATE/feature.yml"]);
  });

  it("returns nothing when there are no templates", () => {
    expect(findTemplatePaths([entry("README.md")])).toEqual([]);
  });

  it("reads only .github/ISSUE_TEMPLATE for a GitHub repo, as GitHub does", () => {
    const tree = [
      entry(".gitea/ISSUE_TEMPLATE/feature.yml"),
      entry("ISSUE_TEMPLATE/root.md"),
      entry(".github/ISSUE_TEMPLATE/bug.yml"),
      entry(".github/ISSUE_TEMPLATE/config.yml"),
    ];
    expect(findTemplatePaths(tree, GITHUB_TEMPLATE_DIRS)).toEqual([".github/ISSUE_TEMPLATE/bug.yml"]);
  });
});

describe("parseTemplate: issue forms", () => {
  const template = parseTemplate(".gitea/ISSUE_TEMPLATE/feature-task.yml", featureTask)!;

  it("parses the TrueRoster form, CRLF line endings and emoji included", () => {
    expect(template).toMatchObject({
      file: "feature-task.yml",
      kind: "form",
      name: "Feature / Task issue template",
      title: "[TYPE]: ",
      labels: [],
    });
    const issueType = template.fields.find((f) => f.id === "issue-type")!;
    expect(issueType).toMatchObject({ type: "dropdown", label: "Issue type", required: true });
    expect(issueType.options[0]).toBe("\u{1F527} Feature");
    expect(template.fields.map((f) => f.label)).toContain("Acceptance criteria - claude add as many as needed");
  });

  it("treats an empty validations block as optional", () => {
    expect(template.fields.at(-1)).toMatchObject({ id: "notes", required: false });
  });

  it("renders a skeleton in Gitea's submitted-form format", () => {
    expect(template.body.startsWith(`### Issue type\n\n${NO_RESPONSE}\n\n### Summary\n\n${NO_RESPONSE}\n`)).toBe(true);
  });

  it("describes required fields and exact dropdown options for the prompt", () => {
    const text = describeTemplate(template);
    expect(text).toContain("- ### Summary [textarea, required]");
    expect(text).toContain('"\u{1F7E1} Medium"');
  });

  it("rejects YAML that is not an issue form", () => {
    expect(parseTemplate("x/form.yml", "name: nope\n")).toBeUndefined();
    expect(parseTemplate("x/form.yml", "body: [unclosed")).toBeUndefined();
  });
});

describe("parseTemplate: Markdown", () => {
  it("reads front matter and keeps the body", () => {
    const md = "---\nname: Bug report\nabout: Something broke\ntitle: 'bug: '\nlabels: bug, triage\n---\n## Steps\n\n1.\n";
    expect(parseTemplate(".gitea/ISSUE_TEMPLATE/bug.md", md)).toMatchObject({
      kind: "markdown",
      name: "Bug report",
      about: "Something broke",
      title: "bug: ",
      labels: ["bug", "triage"],
      body: "## Steps\n\n1.\n",
    });
  });

  it("falls back to the file name without front matter", () => {
    expect(parseTemplate("ISSUE_TEMPLATE/plain.md", "Describe it")).toMatchObject({ name: "plain.md", body: "Describe it" });
  });
});

describe("app templates", () => {
  it("derive a file name from the template name and format", () => {
    expect(appTemplateFile("Feature / Task!", "form")).toBe("feature-task.yml");
    expect(appTemplateFile("  Bug report ", "markdown")).toBe("bug-report.md");
    expect(appTemplateFile("***", "markdown")).toBe("template.md");
  });

  it("accept the real TrueRoster form under the app template's name", () => {
    const check = checkTemplate("form", featureTask, { name: "Feature task" });
    expect(check.errors).toEqual([]);
    expect(check.template).toMatchObject({ kind: "form", name: "Feature task", file: "feature-task.yml" });
    expect(check.template!.fields.length).toBeGreaterThan(3);
  });

  it("report unreadable YAML, a missing body list, and forms without sections", () => {
    expect(checkTemplate("form", "name: x\nbody: [").errors[0]).toMatch(/could not be read/);
    expect(checkTemplate("form", "name: x").errors).toEqual(["An issue form needs a top-level `body:` list of fields."]);
    expect(checkTemplate("form", "- a\n- b").errors[0]).toMatch(/YAML mapping/);
    expect(checkTemplate("form", "body:\n  - type: markdown\n    attributes:\n      value: hi").errors[0]).toMatch(/no fields that produce sections/);
  });

  it("flag duplicate ids and option-less dropdowns as errors, and skipped fields as warnings", () => {
    const yaml = [
      "body:",
      "  - type: input",
      "    id: summary",
      "    attributes: { label: Summary }",
      "  - type: textarea",
      "    id: summary",
      "    attributes: { label: Details }",
      "  - type: dropdown",
      "    id: area",
      "    attributes: { label: Area }",
      "  - type: slider",
      "    id: x",
      "    attributes: { label: X }",
      "  - type: input",
      "    attributes: { label: No id }",
    ].join("\n");
    const check = checkTemplate("form", yaml);
    expect(check.errors).toEqual([
      'Field 2 ("Details"): the id "summary" is used more than once.',
      'Field 3 ("Area"): a dropdown field needs attributes.options.',
    ]);
    expect(check.warnings).toHaveLength(2);
    expect(check.warnings[0]).toMatch(/type "slider" is not supported/);
    expect(check.warnings[1]).toMatch(/needs both an id and attributes.label/);
  });

  it("check Markdown templates: empty, unreadable front matter, Bitbucket labels", () => {
    expect(checkTemplate("markdown", "   ").errors).toEqual(["The template is empty."]);
    expect(checkTemplate("markdown", "---\nname: x\n---\n").errors).toEqual(["The template has front matter but no body."]);
    expect(checkTemplate("markdown", "---\n: [\n---\nBody").warnings[0]).toMatch(/front matter/);
    const labelled = "---\nlabels: [bug]\n---\n## Summary\n";
    expect(checkTemplate("markdown", labelled, { forges: ["gitea"] }).warnings).toEqual([]);
    expect(checkTemplate("markdown", labelled, { forges: ["gitea", "bitbucket"] }).warnings[0]).toMatch(/Bitbucket has no labels/);
  });

  it("parse a run's snapshot under its recorded name and file", () => {
    const t = appTemplateFromSnapshot({ name: "Bug", file: "bug.md", kind: "markdown", content: "---\nname: Other\nlabels: [bug]\n---\n## Steps\n" });
    expect(t).toMatchObject({ name: "Bug", file: "bug.md", kind: "markdown", labels: ["bug"], body: "## Steps\n" });
  });
});
