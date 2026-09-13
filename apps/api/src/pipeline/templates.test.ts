import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NO_RESPONSE, describeTemplate, findTemplatePaths, parseTemplate } from "./templates";

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
