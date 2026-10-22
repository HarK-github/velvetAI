import type { FC, ReactNode } from "react";

export const LoadingState: FC<{ message?: string }> = ({ message = "Loading data..." }) => (
  <div
    style={{
      padding: "40px",
      textAlign: "center",
      background: "var(--surface)",
      border: "1px dashed var(--hairline)",
      borderRadius: "8px",
    }}
  >
    <div
      style={{
        display: "inline-block",
        width: "24px",
        height: "24px",
        border: "2px solid var(--accent)",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 1s linear infinite",
        marginBottom: "12px",
      }}
    />
    <p className="mono" style={{ color: "var(--ink-muted)", fontSize: "14px" }}>
      {message}
    </p>
  </div>
);

export const EmptyState: FC<{ title?: string; message?: string; action?: ReactNode }> = ({
  title = "No Records Found",
  message = "There is currently no data available for this view.",
  action,
}) => (
  <div
    style={{
      padding: "48px 24px",
      textAlign: "center",
      background: "var(--surface)",
      border: "1px solid var(--hairline)",
      borderRadius: "8px",
    }}
  >
    <div
      className="mono"
      style={{ fontSize: "28px", color: "var(--ink-faint)", marginBottom: "12px" }}
    >
      &empty;
    </div>
    <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "8px" }}>{title}</h3>
    <p
      style={{
        color: "var(--ink-muted)",
        fontSize: "14px",
        maxWidth: "400px",
        margin: "0 auto 16px",
      }}
    >
      {message}
    </p>
    {action}
  </div>
);

export const ValidationErrorState: FC<{ errors: Array<{ field?: string; message: string }> }> = ({
  errors,
}) => (
  <div
    style={{
      padding: "16px 20px",
      background: "rgba(239, 68, 68, 0.08)",
      border: "1px solid rgba(239, 68, 68, 0.3)",
      borderRadius: "8px",
      color: "#ef4444",
      marginBottom: "16px",
    }}
  >
    <h4 style={{ fontWeight: 700, fontSize: "14px", marginBottom: "8px" }}>Validation Errors:</h4>
    <ul style={{ paddingLeft: "20px", fontSize: "13px" }}>
      {errors.map((e, i) => (
        <li key={i}>
          {e.field ? <strong>{e.field}: </strong> : null}
          {e.message}
        </li>
      ))}
    </ul>
  </div>
);

export const ForbiddenState: FC<{ message?: string }> = ({
  message = "You do not have active membership permissions for this tenant.",
}) => (
  <div
    style={{
      padding: "36px",
      textAlign: "center",
      background: "rgba(245, 158, 11, 0.08)",
      border: "1px solid rgba(245, 158, 11, 0.3)",
      borderRadius: "8px",
      color: "#d97706",
    }}
  >
    <div className="mono" style={{ fontSize: "24px", marginBottom: "8px" }}>
      [403 FORBIDDEN]
    </div>
    <h3 style={{ fontWeight: 700, fontSize: "16px", marginBottom: "8px" }}>
      Tenant Isolation Boundary
    </h3>
    <p style={{ fontSize: "14px", maxWidth: "450px", margin: "0 auto" }}>{message}</p>
  </div>
);

export const DependencyErrorState: FC<{
  serviceName?: string;
  onRetry?: () => void;
}> = ({ serviceName = "Database", onRetry }) => (
  <div
    style={{
      padding: "36px",
      textAlign: "center",
      background: "rgba(239, 68, 68, 0.08)",
      border: "1px solid rgba(239, 68, 68, 0.3)",
      borderRadius: "8px",
    }}
  >
    <div className="mono" style={{ fontSize: "24px", color: "#ef4444", marginBottom: "8px" }}>
      [503 SERVICE UNAVAILABLE]
    </div>
    <h3 style={{ fontWeight: 700, fontSize: "16px", marginBottom: "8px" }}>
      Dependency Failure ({serviceName})
    </h3>
    <p style={{ color: "var(--ink-muted)", fontSize: "14px", marginBottom: "16px" }}>
      The backend dependency is temporarily unavailable or unreachable.
    </p>
    {onRetry && (
      <button onClick={onRetry} className="button button--secondary">
        Retry Request
      </button>
    )}
  </div>
);
