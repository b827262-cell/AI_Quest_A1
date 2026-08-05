import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "../components/ui/Buttons";

const MOCK_PROFILES = [
  { name: "數學系小明", points: 50, desc: "微積分/數學科學" },
  { name: "資科系小華", points: 80, desc: "程式開發/演算法" },
  { name: "文學院阿君", points: 30, desc: "歷史/人文社會" },
  { name: "資安專家阿誠", points: 100, desc: "網路防禦/XSS檢測" }
];

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleLogin(name: string, points: number) {
    setLoading(true);
    setError("");
    try {
      localStorage.setItem("smartbook.student.name", name);
      localStorage.setItem("smartbook.student.points", String(points));
      localStorage.setItem("smartbook.logout.url", "/login");

      // Simulate API lag
      setTimeout(() => {
        setLoading(false);
        navigate("/dashboard");
      }, 800);
    } catch (e) {
      setError("登入失敗，請重試。");
      setLoading(false);
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) {
      setError("請輸入姓名或帳號");
      return;
    }
    handleLogin(username.trim(), 100);
  }

  return (
    <div className="login-container">
      <div className="login-glass-card">
        <div className="login-header">
          <div className="login-logo">✨</div>
          <h1>iBrain 智匯</h1>
          <p>智能學習書本入口</p>
        </div>

        <form onSubmit={handleFormSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="username">帳號名稱</label>
            <input
              id="username"
              type="text"
              placeholder="請輸入姓名或學號..."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">密碼 (選填)</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
          </div>

          {error && <p className="login-error">{error}</p>}

          <PrimaryButton type="submit" loading={loading} style={{ width: "100%" }}>
            匿名進入
          </PrimaryButton>
        </form>

        <div className="login-divider">
          <span>或選擇 Mock 身分測試</span>
        </div>

        <div className="mock-profiles-grid">
          {MOCK_PROFILES.map((p) => (
            <button
              key={p.name}
              type="button"
              className="mock-profile-btn"
              onClick={() => handleLogin(p.name, p.points)}
              disabled={loading}
            >
              <strong>{p.name}</strong>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
