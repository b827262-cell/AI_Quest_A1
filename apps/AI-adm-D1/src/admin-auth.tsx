import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { adminApi, ApiHttpError, setUnauthorizedHandler } from "./api";

export interface AdminUser {
  username: string;
}

interface AdminAuthContextValue {
  status: "loading" | "authenticated" | "anonymous";
  user: AdminUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AdminAuthContextValue["status"]>("loading");
  const [user, setUser] = useState<AdminUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await adminApi.getAdminMe();
      setUser(result.user);
      setStatus("authenticated");
    } catch (error) {
      if (!(error instanceof ApiHttpError) || error.status === 401) {
        setUser(null);
        setStatus("anonymous");
      } else {
        setUser(null);
        setStatus("anonymous");
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
      setStatus("anonymous");
      if (window.location.pathname !== "/login") {
        navigate("/login", { replace: true, state: { sessionExpired: true } });
      }
    };
    setUnauthorizedHandler(handleUnauthorized);
    return () => setUnauthorizedHandler(undefined);
  }, [navigate]);

  const login = useCallback(async (username: string, password: string) => {
    await adminApi.login(username, password);
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      setUser(null);
      setStatus("anonymous");
      navigate("/login", { replace: true });
    }
  }, [navigate]);

  const value = useMemo(() => ({ status, user, login, logout, refresh }), [status, user, login, logout, refresh]);
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return value;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status } = useAdminAuth();
  const location = useLocation();
  if (status === "loading") {
    return <div className="admin-auth-loading">正在驗證管理員登入狀態……</div>;
  }
  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
