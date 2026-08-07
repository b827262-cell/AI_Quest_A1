import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PrimaryButton } from "../components/ui/Buttons";
import { useStudentAuth } from "../student-auth";

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/books";
  return value;
}

export function ProfileCompletionPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, profile, updateProfile, logout } = useStudentAuth();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [displayName, setDisplayName] = useState(profile?.displayName || "");
  const [schoolName, setSchoolName] = useState(profile?.schoolName || "");
  const [gradeLevel, setGradeLevel] = useState(profile?.gradeLevel || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status === "anonymous") navigate("/login", { replace: true });
    if (status === "authenticated" && profile?.profileCompleted) navigate(next, { replace: true });
  }, [status, profile?.profileCompleted, navigate, next]);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.displayName);
    setSchoolName(profile.schoolName || "");
    setGradeLevel(profile.gradeLevel || "");
  }, [profile]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await updateProfile({ displayName, schoolName, gradeLevel });
      navigate(next, { replace: true });
    } catch {
      setError("請完整填寫姓名、學校與年級。" );
    } finally {
      setSaving(false);
    }
  }

  if (status !== "authenticated") return <div className="login-container"><p className="muted">正在載入個人資料……</p></div>;

  return (
    <div className="login-container">
      <div className="login-glass-card">
        <div className="login-header">
          <div className="login-logo">✦</div>
          <h1>完成學員資料</h1>
          <p>完成後才能進入學習內容。</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <div className="form-group">
            <label htmlFor="student-display-name">姓名</label>
            <input id="student-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={saving} required maxLength={120} />
          </div>
          <div className="form-group">
            <label htmlFor="student-school-name">學校</label>
            <input id="student-school-name" value={schoolName} onChange={(event) => setSchoolName(event.target.value)} disabled={saving} required maxLength={160} />
          </div>
          <div className="form-group">
            <label htmlFor="student-grade-level">年級</label>
            <input id="student-grade-level" value={gradeLevel} onChange={(event) => setGradeLevel(event.target.value)} disabled={saving} required maxLength={80} />
          </div>
          {error ? <p className="login-error">{error}</p> : null}
          <PrimaryButton type="submit" loading={saving} disabled={saving}>
            {saving ? "儲存中……" : "儲存並開始學習"}
          </PrimaryButton>
        </form>
        <button type="button" className="mock-profile-btn" onClick={() => void logout()} disabled={saving}>
          登出其他帳號
        </button>
      </div>
    </div>
  );
}
