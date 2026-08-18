import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PrimaryButton } from "../components/ui/Buttons";
import { useStudentAuth } from "../student-auth";

function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/books";
  return value;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status } = useStudentAuth();
  const [error, setError] = useState("");
  const from = safeNext((location.state as { from?: unknown } | null)?.from);
  const reason = (location.state as { reason?: string } | null)?.reason;

  useEffect(() => {
    if (status === "authenticated") navigate(from, { replace: true });
  }, [status, navigate, from]);

  function beginGoogleLogin() {
    setError("");
    try {
      window.location.assign(`/api/student/auth/google/start?returnTo=${encodeURIComponent(from)}`);
    } catch {
      setError("無法啟動 Google 登入，請稍後再試。" );
    }
  }

  return (
    <div className="login-container">
      <div className="login-glass-card">
        <div className="login-header">
          <div className="login-logo">✨</div>
          <h1>iBrain 智匯</h1>
          <p>智能學習書本入口</p>
        </div>
        {reason === "session_expired" ? <p className="login-error">登入狀態已到期，請重新登入。</p> : null}
        {error ? <p className="login-error">{error}</p> : null}
        <PrimaryButton type="button" onClick={beginGoogleLogin} disabled={status === "loading"}>
          使用 Google 登入
        </PrimaryButton>
        <p className="muted login-help-text">登入後，系統會在伺服器建立可撤銷的學員 session。</p>
      </div>
    </div>
  );
}
