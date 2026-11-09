import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ error, errorInfo });
    // Keep dev console informed for debugging
    if (typeof console !== "undefined" && console.error) {
      console.error("ErrorBoundary caught an unhandled render error:", error, errorInfo);
    }
  }

  private handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isDev =
        typeof import.meta !== "undefined" && import.meta.env
          ? Boolean(import.meta.env.DEV)
          : false;

      return (
        <main
          id="error-boundary-fallback"
          role="alert"
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "40px 20px",
            background: "var(--paper, #0b0c10)",
            color: "var(--ink, #ffffff)",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "600px",
              width: "100%",
              background: "var(--surface, #141720)",
              border: "1px solid var(--hairline, rgba(255, 255, 255, 0.12))",
              borderRadius: "12px",
              padding: "36px 32px",
              boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                background: "rgba(239, 68, 68, 0.15)",
                color: "var(--crimson, #ef4444)",
                fontSize: "24px",
                marginBottom: "20px",
              }}
            >
              ⚠
            </div>

            <h1
              style={{
                fontSize: "22px",
                fontWeight: 600,
                margin: "0 0 12px 0",
                letterSpacing: "-0.01em",
              }}
            >
              Something went wrong
            </h1>

            <p
              style={{
                fontSize: "14px",
                color: "var(--secondary, #94a3b8)",
                lineHeight: 1.6,
                margin: "0 0 24px 0",
              }}
            >
              An unexpected error occurred during rendering. Please reload the page to restore your
              session.
            </p>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: "12px",
                marginBottom: isDev ? "24px" : "0",
              }}
            >
              <button
                type="button"
                onClick={this.handleReload}
                className="button button--solid"
                id="error-boundary-reload-btn"
                style={{
                  background: "var(--accent, #3b82f6)",
                  color: "#ffffff",
                  border: "none",
                  padding: "10px 20px",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Reload
              </button>
            </div>

            {isDev && this.state.error && (
              <details
                open
                style={{
                  marginTop: "20px",
                  textAlign: "left",
                  background: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  fontSize: "12px",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    color: "var(--crimson, #ef4444)",
                    fontWeight: 600,
                    fontFamily: "var(--font-mono, monospace)",
                    marginBottom: "8px",
                  }}
                >
                  {this.state.error.name}: {this.state.error.message}
                </summary>
                {this.state.error.stack && (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      color: "#94a3b8",
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "11px",
                      lineHeight: 1.5,
                      margin: "8px 0 0 0",
                      maxHeight: "220px",
                      overflowY: "auto",
                    }}
                  >
                    {this.state.error.stack}
                  </pre>
                )}
                {this.state.errorInfo?.componentStack && (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      color: "#64748b",
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "10px",
                      lineHeight: 1.4,
                      marginTop: "8px",
                      maxHeight: "150px",
                      overflowY: "auto",
                    }}
                  >
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </details>
            )}
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
