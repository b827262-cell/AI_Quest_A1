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

/**
 * Must match `ADMIN_AUTH_REQUIRED_CODE`/`ADMIN_AUTH_STATE_HEADER` in
 * `apps/AI-adm-D1/src/server/ai/admin-auth.ts` — keep both copies in sync if
 * either changes. A 401 is only treated as "session invalid" when it carries
 * one of these two markers; any other 401 (business logic, a route that
 * doesn't go through the admin auth boundary, etc.) is left alone.
 */
const ADMIN_AUTH_STATE_HEADER = "x-admin-auth-state";
const ADMIN_AUTH_REQUIRED_CODE = "ADMIN_AUTH_REQUIRED";

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
 * A 401 is a genuine "this session is invalid" signal only when the server
 * marks it as such (see the header/code constants above). Checks the header
 * first (cheap, doesn't touch the body); falls back to a cloned-body JSON
 * check so the caller still receives an intact, unconsumed response either
 * way. Any parse failure (empty body, non-JSON) is treated as "not marked".
 */
async function isAdminAuthRequiredResponse(response: Response): Promise<boolean> {
  if (response.headers.get(ADMIN_AUTH_STATE_HEADER) === "invalid") return true;
  try {
    const body: unknown = await response.clone().json();
    return Boolean(body && typeof body === "object" && (body as Record<string, unknown>).code === ADMIN_AUTH_REQUIRED_CODE);
  } catch {
    return false;
  }
}

/**
 * Decides whether a 401 response should invalidate the browser session, and
 * does so at most once per still-current token. All four conditions must
 * hold:
 *
 * 1. The request actually carried a token (`dispatchedToken`) — an
 *    unauthenticated request's 401 says nothing about an existing session.
 * 2. The response status is 401.
 * 3. The response is marked as a genuine auth failure (not a business 401).
 * 4. `getAdminToken()` still equals `dispatchedToken` at the moment we act —
 *    checked both before and after the (async) marker check. This rejects a
 *    late/stale response for a token that isn't current anymore (e.g. a
 *    wrong-password login probe answered after a real login already
 *    succeeded, or a slow request that outlives a fresh re-login), and it is
 *    also what makes concurrent 401s single-flight: once the first one clears
 *    the token, every other pending check's final comparison fails and it
 *    becomes a no-op — no extra dedupe flag needed, since the check and the
 *    clear it guards run back-to-back with no `await` in between.
 */
async function maybeInvalidateAdminSession(response: Response, dispatchedToken: string | null): Promise<void> {
  if (response.status !== 401 || !dispatchedToken) return;
  if (getAdminToken() !== dispatchedToken) return;
  const authRequired = await isAdminAuthRequiredResponse(response);
  if (!authRequired) return;
  if (getAdminToken() !== dispatchedToken) return;
  clearAdminToken();
  window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
}

/**
 * Installs one same-origin fetch boundary for all `/api/admin/*` calls.
 * The token stays in sessionStorage, never in the URL. A 401 only clears the
 * session when the server explicitly marks it as an auth failure and the
 * token that produced it is still the one currently in use — see
 * {@link maybeInvalidateAdminSession}.
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
    const dispatchedToken = authenticatedHeaders.get("x-admin-token")
      || authenticatedHeaders.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
      || null;

    const response = input instanceof Request
      ? await nativeFetch(new Request(input, { ...init, headers: authenticatedHeaders }))
      : await nativeFetch(input, { ...init, headers: authenticatedHeaders });

    await maybeInvalidateAdminSession(response, dispatchedToken);
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
