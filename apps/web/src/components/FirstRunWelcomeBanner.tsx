import { useState, useEffect, type FC } from "react";
import { useAuth0 } from "@auth0/auth0-react";

const WELCOME_STORAGE_PREFIX = "velvetai_welcome_seen_v1";

function hashSubjectForStorage(sub: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sub.length; i++) {
    hash ^= sub.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function getWelcomeStorageKey(sub?: string | null): string {
  return sub ? `${WELCOME_STORAGE_PREFIX}:${hashSubjectForStorage(sub)}` : WELCOME_STORAGE_PREFIX;
}

interface FirstRunWelcomeBannerProps {
  onOpenAi: () => void;
}

export const FirstRunWelcomeBanner: FC<FirstRunWelcomeBannerProps> = ({ onOpenAi }) => {
  const { isAuthenticated, isLoading, user } = useAuth0();
  const [dismissed, setDismissed] = useState<boolean>(true);

  const storageKey = getWelcomeStorageKey(user?.sub ?? null);

  useEffect(() => {
    if (isLoading || !isAuthenticated) {
      setDismissed(true);
      return;
    }
    try {
      const seen = window.localStorage.getItem(storageKey) === "1";
      setDismissed(seen);
    } catch {
      setDismissed(false);
    }
  }, [isAuthenticated, isLoading, storageKey]);

  if (!isAuthenticated || isLoading || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // Ignore storage failures
    }
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="First-run welcome"
      data-testid="first-run-welcome-card"
      style={{
        marginTop: "var(--nav-height)",
        padding: "14px var(--page-padding)",
        background: "#12131a",
        color: "#f5f5f7",
        borderBottom: "1px solid rgba(124, 151, 255, 0.35)",
      }}
    >
      <div
        style={{
          maxWidth: "var(--max-width)",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: "1 1 320px" }}>
          <span className="signal-dot signal-dot--emerald" aria-hidden="true"></span>
          <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5, color: "#f5f5f7" }}>
            Welcome — you can now book with Ask AI. Paying uses PayPal Sandbox: use the sandbox
            buyer from the testing instructions.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            className="button button--primary button--sm"
            onClick={() => {
              handleDismiss();
              onOpenAi();
            }}
          >
            Ask AI
          </button>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={handleDismiss}
            style={{ color: "#d1d5db", borderColor: "rgba(255,255,255,0.22)" }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};
