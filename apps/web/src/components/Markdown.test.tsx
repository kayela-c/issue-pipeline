import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders Markdown structure", () => {
    const html = renderToStaticMarkup(<Markdown>{"### Summary\n\nSome **bold** text"}</Markdown>);
    expect(html).toContain("<h3>Summary</h3>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("never renders raw HTML or javascript: links from draft text", () => {
    const html = renderToStaticMarkup(
      <Markdown>{'<script>alert(1)</script><img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))'}</Markdown>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
  });
});
