import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../adminAuth";

function loginErrorMessage(status: number): string {
  if (status === 401) return "管理員憑證無效或已過期，請重新輸入。";
  if (status === 403) return "此憑證沒有管理後台權限。";
  if (status === 503) return "管理端驗證尚未完成設定，請聯絡系統管理員。";
  return "登入驗證失敗，請確認 API Server 狀態後重試。";
}

export function AdminLoginPage() {
  const navigate = useNavigate();
  const { login } = useAdminAuth();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError("請輸入管理員憑證。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/qm/status", {
        headers: { "x-admin-token": candidate }
      });
      if (!response.ok) {
        setError(loginErrorMessage(response.status));
        return;
      }
      login(candidate);
      setToken("");
      navigate("/admin", { replace: true });
    } catch {
      setError("無法連線至管理 API，請確認服務是否啟動。 ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#f4f7fb"
      }}
    >
      <form
        className="admin-card"
        onSubmit={submit}
        style={{ width: "min(420px, 100%)", margin: 0 }}
      >
        <div className="admin-card-head">
          <div>
            <div className="admin-card-kicker" style={{ margin: 0 }}>iBrain 智匯</div>
            <h1 style={{ margin: "6px 0 0", fontSize: 24 }}>管理後台登入</h1>
          </div>
          <span className="admin-avatar" aria-hidden="true">管</span>
        </div>

        <p className="muted" style={{ marginBottom: 18 }}>
          請輸入管理端憑證。憑證只保存在目前瀏覽器分頁的 sessionStorage，不會寫入網址。
        </p>

        <label htmlFor="admin-token">管理員憑證</label>
        <input
          id="admin-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="current-password"
          disabled={submitting}
          aria-invalid={Boolean(error)}
          autoFocus
        />

        {error && (
          <p className="error" role="alert" style={{ margin: "12px 0 0" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          className="admin-btn"
          disabled={submitting}
          style={{ width: "100%", marginTop: 18 }}
        >
          {submitting ? "驗證中..." : "登入管理後台"}
        </button>
      </form>
    </main>
  );
}
