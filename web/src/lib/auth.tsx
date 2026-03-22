import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { DEV_EMAIL_KEY, account } from "./api";

const CF_LOGOUT_URL = "https://trips-api.prenticew.com/cdn-cgi/access/logout";

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

  // In dev, show the login form if no email is stored yet
  const [devLoginPending, setDevLoginPending] = useState(
    () => import.meta.env.DEV && !localStorage.getItem(DEV_EMAIL_KEY)
  );
  const [devLoginError, setDevLoginError] = useState("");

  const fetchMe = useCallback(async () => {
    if (import.meta.env.DEV && !localStorage.getItem(DEV_EMAIL_KEY)) {
      setLoading(false);
      return;
    }
    try {
      setUser(await account.getMe());
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
    <AuthContext.Provider value={{ user, loading, devLoginPending, devLoginError, devLogin, logout, refreshUser: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
