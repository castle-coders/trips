import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { DEV_EMAIL_KEY, LINK_TOKEN_KEY, LINK_TOKEN_EXPIRES_KEY, account, type LinkPreview } from "./api";

const CF_LOGOUT_URL = "https://trips.prenticew.com/cdn-cgi/access/logout";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Pending link token detected — Account page should show confirmation UI */
  pendingLink: { token: string; preview: LinkPreview } | null;
  confirmLink: () => Promise<void>;
  cancelLink: () => void;
  linkResult: "merged" | "same" | null;
  clearLinkResult: () => void;
  devLoginPending: boolean;
  devLoginError: string;
  devLogin: (email: string) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingLink, setPendingLink] = useState<{ token: string; preview: LinkPreview } | null>(null);
  const [linkResult, setLinkResult] = useState<"merged" | "same" | null>(null);

  // In dev, show the login form if no email is stored yet
  const [devLoginPending, setDevLoginPending] = useState(
    () => import.meta.env.DEV && !localStorage.getItem(DEV_EMAIL_KEY)
  );
  const [devLoginError, setDevLoginError] = useState("");

  const clearLinkResult = useCallback(() => setLinkResult(null), []);

  const fetchMe = useCallback(async () => {
    if (import.meta.env.DEV && !localStorage.getItem(DEV_EMAIL_KEY)) {
      setLoading(false);
      return;
    }
    try {
      const me = await account.getMe();
      setUser(me);

      // Check for pending account link token
      const linkToken = localStorage.getItem(LINK_TOKEN_KEY);
      const linkExpires = localStorage.getItem(LINK_TOKEN_EXPIRES_KEY);
      if (linkToken) {
        // Check if expired
        if (linkExpires && new Date(linkExpires) < new Date()) {
          localStorage.removeItem(LINK_TOKEN_KEY);
          localStorage.removeItem(LINK_TOKEN_EXPIRES_KEY);
          return;
        }

        // Fetch preview instead of auto-merging
        try {
          const preview = await account.previewLinkToken(linkToken);
          if (preview.isSelf) {
            // Same user logged back in — clear token, no merge needed
            localStorage.removeItem(LINK_TOKEN_KEY);
            localStorage.removeItem(LINK_TOKEN_EXPIRES_KEY);
            setLinkResult("same");
          } else {
            // Different user — show confirmation UI
            setPendingLink({ token: linkToken, preview });
            // Redirect to /account if not already there so the user sees the confirmation banner
            if (window.location.pathname !== "/account") {
              window.location.href = "/account";
            }
          }
        } catch {
          // Token invalid/expired — clean up silently
          localStorage.removeItem(LINK_TOKEN_KEY);
          localStorage.removeItem(LINK_TOKEN_EXPIRES_KEY);
        }
      }
    } catch {
      setUser(null);
      if (import.meta.env.DEV) {
        localStorage.removeItem(DEV_EMAIL_KEY);
        setDevLoginError("Sign-in failed — is the API running with DEV_MODE=true?");
        setDevLoginPending(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const confirmLink = useCallback(async () => {
    if (!pendingLink) return;
    try {
      const merged = await account.consumeLinkToken(pendingLink.token);
      setUser(merged);
      setLinkResult("merged");
    } catch {
      // Token may have expired between preview and confirm
    } finally {
      localStorage.removeItem(LINK_TOKEN_KEY);
      localStorage.removeItem(LINK_TOKEN_EXPIRES_KEY);
      setPendingLink(null);
    }
  }, [pendingLink]);

  const cancelLink = useCallback(() => {
    localStorage.removeItem(LINK_TOKEN_KEY);
    localStorage.removeItem(LINK_TOKEN_EXPIRES_KEY);
    setPendingLink(null);
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const devLogin = useCallback((email: string) => {
    localStorage.setItem(DEV_EMAIL_KEY, email);
    setDevLoginError("");
    setDevLoginPending(false);
    fetchMe();
  }, [fetchMe]);

  const logout = () => {
    if (import.meta.env.DEV) {
      localStorage.removeItem(DEV_EMAIL_KEY);
      setUser(null);
      setDevLoginPending(true);
      return;
    }
    window.location.href = CF_LOGOUT_URL;
  };

  return (
    <AuthContext.Provider value={{
      user, loading, pendingLink, confirmLink, cancelLink,
      linkResult, clearLinkResult,
      devLoginPending, devLoginError, devLogin, logout, refreshUser: fetchMe,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
