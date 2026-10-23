import React from "react";
import ReactMarkdown from "react-markdown";

/**
 * Validates and sanitizes URLs for links rendered in markdown prose.
 * Rejects javascript:, vbscript:, data: protocols to prevent XSS.
 */
export function isSafeUrl(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("vbscript:") ||
    trimmed.startsWith("data:")
  ) {
    return false;
  }
  return true;
}

export interface SafeMarkdownProps {
  content: string;
  className?: string;
}

/**
 * Safe Markdown prose renderer for VelvetAI Ask AI.
 * Strict invariants:
 * - No raw HTML enabled (no rehype-raw).
 * - External links open safely in new tab with rel="noopener noreferrer".
 * - Dangerous javascript:/vbscript:/data: protocols rejected.
 * - Styles match existing dark luxury UI.
 */
export function SafeMarkdown({ content, className = "" }: SafeMarkdownProps): React.JSX.Element {
  return (
    <div className={`ai-markdown-prose ${className}`.trim()}>
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            if (!isSafeUrl(href)) {
              return <span className="ai-md-unsafe-link">{children}</span>;
            }
            const isExternal =
              href?.startsWith("http://") || href?.startsWith("https://") || href?.startsWith("//");
            return (
              <a
                href={href}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noopener noreferrer" : undefined}
                className="ai-md-link"
              >
                {children}
              </a>
            );
          },
          h1: ({ children }) => <h3 className="ai-md-heading ai-md-h1">{children}</h3>,
          h2: ({ children }) => <h4 className="ai-md-heading ai-md-h2">{children}</h4>,
          h3: ({ children }) => <h5 className="ai-md-heading ai-md-h3">{children}</h5>,
          p: ({ children }) => <p className="ai-md-paragraph">{children}</p>,
          ul: ({ children }) => <ul className="ai-md-list ai-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="ai-md-list ai-md-ol">{children}</ol>,
          li: ({ children }) => <li className="ai-md-li">{children}</li>,
          strong: ({ children }) => <strong className="ai-md-strong">{children}</strong>,
          em: ({ children }) => <em className="ai-md-em">{children}</em>,
          code: ({ children, className: codeClass }) => (
            <code className={`ai-md-code ${codeClass || ""}`.trim()}>{children}</code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="ai-md-blockquote">{children}</blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
