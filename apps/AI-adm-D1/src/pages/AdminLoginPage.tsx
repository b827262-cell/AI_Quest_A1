import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../adminAuth";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const { login } = useAdminAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = password.trim();
    if (!candidate) {
      setError("請輸入密碼。");
      return;
    }

    setError(null);
    login(candidate);
    setPassword("");
    navigate("/admin", { replace: true });
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
          開發模式請輸入管理密碼。密碼只保存在目前瀏覽器分頁的 sessionStorage，不會寫入網址。
        </p>

        <label htmlFor="admin-password">密碼</label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
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
          style={{ width: "100%", marginTop: 18 }}
        >
          登入管理後台
        </button>
      </form>
    </main>
  );
}
