import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

const ADMIN_TOKEN_STORAGE_KEY = "ai-quest.admin-token";
const ADMIN_AUTH_EXPIRED_EVENT = "ai-quest:admin-auth-expired";
const FETCH_INTERCEPTOR_MARK = "__aiQuestAdminFetchInstalled";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getAdminToken(): string | null {
  const value = storage()?.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim();
  return value || null;
}

export function setAdminToken(token: string): void {
  const normalized = token.trim();
  if (!normalized) {
    clearAdminToken();
    return;
  }
  storage()?.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized);
}

export function clearAdminToken(): void {
  storage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function isAdminApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/admin/");
  } catch {
    return false;
  }
}

export function buildAdminAuthHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const token = getAdminToken();
  if (token && !headers.has("x-admin-token") && !headers.has("authorization")) {
    headers.set("x-admin-token", token);
  }
  return headers;
}

/**
 * Installs one same-origin fetch boundary for all `/api/admin/*` calls.
 * The token stays in sessionStorage, never in the URL, and a 401 invalidates
 * the browser session immediately.
 */
export function installAdminFetchInterceptor(): void {
  if (typeof window === "undefined") return;

  const markedWindow = window as typeof window & { [FETCH_INTERCEPTOR_MARK]?: boolean };
  if (markedWindow[FETCH_INTERCEPTOR_MARK]) return;
  markedWindow[FETCH_INTERCEPTOR_MARK] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isAdminApiRequest(input)) return nativeFetch(input, init);

    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const headers = new Headers(requestHeaders);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const authenticatedHeaders = buildAdminAuthHeaders(headers);

    const response = input instanceof Request
      ? await nativeFetch(new Request(input, { ...init, headers: authenticatedHeaders }))
      : await nativeFetch(input, { ...init, headers: authenticatedHeaders });

    if (response.status === 401) {
      clearAdminToken();
      window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    }
    return response;
  };
}

type AdminAuthContextValue = {
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
};

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getAdminToken());

  const login = useCallback((nextToken: string) => {
    setAdminToken(nextToken);
    setToken(getAdminToken());
  }, []);

  const logout = useCallback(() => {
    clearAdminToken();
    setToken(null);
  }, []);

  useEffect(() => {
    const expire = () => setToken(null);
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, expire);
    return () => window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, expire);
  }, []);

  const value = useMemo<AdminAuthContextValue>(() => ({
    isAuthenticated: Boolean(token),
    login,
    logout
  }), [login, logout, token]);

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return value;
}
