import ReactMarkdown from "react-markdown";

/**
 * Renders draft bodies. Draft text is written by an AI from untrusted notes,
 * so raw HTML is never rendered (`skipHtml`), and react-markdown's default URL
 * filter drops `javascript:` and other unsafe links. Links open in a new tab.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children: text }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
