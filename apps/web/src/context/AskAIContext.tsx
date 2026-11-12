import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type FC,
  type ReactNode,
} from "react";
import { apiClient } from "../api-client.js";

export const ASK_AI_STORAGE_PREFIX = "velvetai_askai_v1:";

export interface ActiveQuoteState {
  quoteId?: string;
  serviceId: string;
  locationId: string;
  serviceName?: string;
  startsAt: string;
  timeZone?: string;
  expiresAt?: string;
}

export interface ActiveHoldState {
  bookingId: string;
  locator: string;
  serviceId: string;
  locationId?: string;
  serviceName?: string;
  startsAt: string;
  timeZone?: string;
  holdExpiresAt?: string;
  timeLabel: string;
  quoteId?: string;
  status: "HELD" | "CANCELLED" | "COMMITTED";
}

interface PersistedAskAIState {
  messages: unknown[];
  activeQuote: ActiveQuoteState | null;
  activeHold: ActiveHoldState | null;
}

export interface AuthSessionSnapshot {
  sub: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface AskAIContextValue {
  hasProvider: boolean;
  isOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  setIsOpen: (open: boolean) => void;
  messages: any[];
  setMessages: (updater: any[] | ((prev: any[]) => any[])) => void;
  activeQuote: ActiveQuoteState | null;
  setActiveQuote: (quote: ActiveQuoteState | null) => void;
  activeHold: ActiveHoldState | null;
  setActiveHold: (hold: ActiveHoldState | null) => void;
  authSub: string | null;
  hydrationVersion: number;
  clearVersion: number;
  syncAuthState: (snapshot: AuthSessionSnapshot) => void;
  clearConversation: (options?: { resetAuth?: boolean }) => void;
}

const noop = () => {};

const defaultAskAIContext: AskAIContextValue = {
  hasProvider: false,
  isOpen: false,
  openDrawer: noop,
  closeDrawer: noop,
  setIsOpen: noop,
  messages: [],
  setMessages: noop,
  activeQuote: null,
  setActiveQuote: noop,
  activeHold: null,
  setActiveHold: noop,
  authSub: null,
  hydrationVersion: 0,
  clearVersion: 0,
  syncAuthState: noop,
  clearConversation: noop,
};

const AskAIContext = createContext<AskAIContextValue>(defaultAskAIContext);

export const useAskAI = (): AskAIContextValue => useContext(AskAIContext);

function safeReadPersisted(sub: string): PersistedAskAIState | null {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(`${ASK_AI_STORAGE_PREFIX}${sub}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAskAIState>;
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      activeQuote: parsed.activeQuote ?? null,
      activeHold: parsed.activeHold ?? null,
    };
  } catch {
    return null;
  }
}

function safeWritePersisted(sub: string, state: PersistedAskAIState): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(`${ASK_AI_STORAGE_PREFIX}${sub}`, JSON.stringify(state));
  } catch {
    // Ignore storage quota or restricted storage errors
  }
}

function safeRemovePersisted(sub?: string | null): void {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return;
  }
  try {
    if (sub) {
      window.sessionStorage.removeItem(`${ASK_AI_STORAGE_PREFIX}${sub}`);
    }
    const keysToDelete: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(ASK_AI_STORAGE_PREFIX)) {
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) {
      window.sessionStorage.removeItem(k);
    }
  } catch {
    // Ignore storage access errors
  }
}

export const AskAIProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [messages, setMessagesState] = useState<any[]>([]);
  const [activeQuote, setActiveQuote] = useState<ActiveQuoteState | null>(null);
  const [activeHold, setActiveHold] = useState<ActiveHoldState | null>(null);
  const [authSub, setAuthSub] = useState<string | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState<number>(0);
  const [clearVersion, setClearVersion] = useState<number>(0);

  const hydratedSubRef = useRef<string | null>(null);
  const wasAuthenticatedRef = useRef<boolean>(false);

  const openDrawer = useCallback(() => setIsOpen(true), []);
  const closeDrawer = useCallback(() => setIsOpen(false), []);

  const setMessages = useCallback((updater: any[] | ((prev: any[]) => any[])) => {
    setMessagesState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      return next;
    });
  }, []);

  const clearConversation = useCallback(
    (options?: { resetAuth?: boolean }) => {
      safeRemovePersisted(hydratedSubRef.current || authSub);
      setMessagesState([]);
      setActiveQuote(null);
      setActiveHold(null);
      apiClient.resetActionKeys();
      setClearVersion((v) => v + 1);
      if (options?.resetAuth) {
        hydratedSubRef.current = null;
        wasAuthenticatedRef.current = false;
        setAuthSub(null);
      }
    },
    [authSub],
  );

  const syncAuthState = useCallback(
    (snapshot: AuthSessionSnapshot) => {
      if (snapshot.isLoading) {
        return;
      }

      if (snapshot.isAuthenticated && snapshot.sub) {
        wasAuthenticatedRef.current = true;
        if (hydratedSubRef.current !== snapshot.sub) {
          const restored = safeReadPersisted(snapshot.sub);
          hydratedSubRef.current = snapshot.sub;
          setAuthSub(snapshot.sub);
          if (restored) {
            setMessagesState(restored.messages);
            setActiveQuote(restored.activeQuote);
            setActiveHold(restored.activeHold);
            setHydrationVersion((v) => v + 1);
          } else {
            setMessagesState([]);
            setActiveQuote(null);
            setActiveHold(null);
          }
        }
        return;
      }

      if (wasAuthenticatedRef.current || hydratedSubRef.current !== null) {
        clearConversation({ resetAuth: true });
      }
    },
    [clearConversation],
  );

  useEffect(() => {
    if (!authSub || hydratedSubRef.current !== authSub) {
      return;
    }
    safeWritePersisted(authSub, {
      messages,
      activeQuote,
      activeHold,
    });
  }, [authSub, messages, activeQuote, activeHold]);

  return (
    <AskAIContext.Provider
      value={{
        hasProvider: true,
        isOpen,
        openDrawer,
        closeDrawer,
        setIsOpen,
        messages,
        setMessages,
        activeQuote,
        setActiveQuote,
        activeHold,
        setActiveHold,
        authSub,
        hydrationVersion,
        clearVersion,
        syncAuthState,
        clearConversation,
      }}
    >
      {children}
    </AskAIContext.Provider>
  );
};
