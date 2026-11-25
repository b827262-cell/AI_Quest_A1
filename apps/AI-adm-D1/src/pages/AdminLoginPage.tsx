import { FormEvent, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { adminApi, ApiHttpError } from "../api";
import { useAdminAuth } from "../admin-auth";

function isLoopbackHost(): boolean {
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function AdminLoginPage() {
  const { status, login } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [devLogin, setDevLogin] = useState(false);
  const autoLoginAttempted = useRef(false);

  useEffect(() => {
    if (status === "authenticated") navigate("/admin", { replace: true });
  }, [navigate, status]);

  useEffect(() => {
    if (status !== "anonymous" || autoLoginAttempted.current || !isLoopbackHost()) return;
    autoLoginAttempted.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const mode = await adminApi.getAdminAuthMode();
        if (cancelled || !mode.devLogin || !mode.devUsername) return;
        setDevLogin(true);
        setUsername(mode.devUsername);
        await login(mode.devUsername, "");
      } catch {
        // Fall back to the regular password form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, login]);

  if (status === "loading") return <div className="admin-auth-loading">正在載入登入頁……</div>;
  if (status === "authenticated") return <Navigate to="/admin" replace />;

  const sessionExpired = Boolean((location.state as { sessionExpired?: boolean } | null)?.sessionExpired);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      setPassword("");
      navigate("/admin", { replace: true });
    } catch (cause) {
      setPassword("");
      setError(cause instanceof ApiHttpError && cause.status === 401 ? "管理員帳號或密碼錯誤。" : "登入服務暫時無法使用，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="admin-login-page">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-mark">iB</div>
        <h1 id="admin-login-title">管理端登入</h1>
        <p className="admin-login-subtitle">請使用管理員帳號登入 iBrain AI。</p>
        {sessionExpired && <p className="admin-login-notice">登入工作階段已過期，請重新登入。</p>}
        {devLogin && <p className="admin-login-notice">本機開發模式：只需帳號，免密碼。</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <form onSubmit={submit}>
          <label htmlFor="admin-username">帳號</label>
          <input
            id="admin-username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
          <label htmlFor="admin-password">密碼</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required={!devLogin}
          />
          <button className="admin-btn admin-login-submit" type="submit" disabled={submitting}>
            {submitting ? "登入中……" : "登入"}
          </button>
        </form>
      </section>
    </main>
  );
}
