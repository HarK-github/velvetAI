import type { FC } from "react";
import { ApiError } from "../api-client.js";

export function isUserNotProvisionedError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.problem.code === "user_not_provisioned" || /user_not_provisioned/i.test(err.message);
  }
  if (err instanceof Error) {
    return /user_not_provisioned/i.test(err.message);
  }
  if (typeof err === "string") {
    return /user_not_provisioned/i.test(err);
  }
  return false;
}

interface AccountProvisioningNoticeProps {
  onRetry?: () => void;
  retrying?: boolean;
  darkSurface?: boolean;
}

export const AccountProvisioningNotice: FC<AccountProvisioningNoticeProps> = ({
  onRetry,
  retrying = false,
  darkSurface = false,
}) => {
  return (
    <div
      role="status"
      data-testid="account-not-provisioned-notice"
      style={{
        background: darkSurface ? "rgba(245, 158, 11, 0.14)" : "rgba(245, 158, 11, 0.10)",
        border: "1px solid rgba(245, 158, 11, 0.40)",
        borderRadius: "8px",
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "12px",
        color: darkSurface ? "#fef3c7" : "var(--ink)",
      }}
    >
      <div>
        <strong style={{ display: "block", fontSize: "14px" }}>
          Your account isn&apos;t set up yet
        </strong>
        <span
          style={{
            display: "block",
            fontSize: "13px",
            marginTop: "4px",
            color: darkSurface ? "rgba(255,255,255,0.82)" : "var(--text-body)",
          }}
        >
          Your sign-in succeeded, but workspace setup hasn&apos;t completed yet. Please wait a
          moment and try again.
        </span>
      </div>
      {onRetry && (
        <button
          type="button"
          className="button button--outline"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "Retrying..." : "Retry"}
        </button>
      )}
    </div>
  );
};
