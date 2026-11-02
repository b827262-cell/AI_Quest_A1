import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PrimaryButton } from "../components/ui/Buttons";
import { useStudentAuth } from "../student-auth";
import { safeStudentReturnTo } from "@ai-smartbook/auth/browser";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status } = useStudentAuth();
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const from = safeStudentReturnTo((location.state as { from?: string } | null)?.from);
  const reason = (location.state as { reason?: string } | null)?.reason;

  useEffect(() => {
    if (status === "authenticated") navigate(from, { replace: true });
  }, [status, navigate, from]);

  async function passcodeLogin(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const response = await fetch("/api/student/auth/passcode/login", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, passcode, returnTo: from }) });
      if (!response.ok) { setError(response.status === 429 ? "登入嘗試次數過多，請稍後再試。" : "電子郵件或通行碼不正確。"); return; }
      const result = await response.json() as { redirectTo: string };
      window.location.assign(safeStudentReturnTo(result.redirectTo));
    } catch { setError("登入失敗，請稍後再試。"); }
    finally { setBusy(false); }
  }

  function beginAccessLogin() {
    setError("");
    try {
      window.location.assign(`/api/student/auth/access/login?returnTo=${encodeURIComponent(from)}`);
    } catch {
      setError("無法啟動電子郵件登入，請稍後再試。" );
    }
  }

  return (
    <div className="login-container">
      <div className="login-glass-card">
        <div className="login-header">
          <div className="login-logo">✨</div>
          <h1>iBrain AI</h1>
          <p>智能學習書本入口</p>
        </div>
        {reason === "session_expired" ? <p className="login-error">登入狀態已到期，請重新登入。</p> : null}
        {error ? <p className="login-error">{error}</p> : null}
        <form className="login-form passcode-login-form" onSubmit={(event) => void passcodeLogin(event)}>
          <div className="form-group"><label>電子郵件<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label></div>
          <div className="form-group"><label>通行碼<input type="password" autoComplete="current-password" required value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label></div>
          <PrimaryButton type="submit" disabled={busy || status === "loading"}>以通行碼登入</PrimaryButton>
        </form>
        <PrimaryButton type="button" onClick={beginAccessLogin} disabled={status === "loading"}>
          以電子郵件登入（Cloudflare Access）
        </PrimaryButton>
        <p className="muted login-help-text">登入後，系統會在伺服器建立可撤銷的學員 session。</p>
      </div>
    </div>
  );
}
