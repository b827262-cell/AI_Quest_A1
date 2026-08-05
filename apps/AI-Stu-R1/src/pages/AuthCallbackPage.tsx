import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStudentAuth } from "../student-auth";

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}

/**
 * OAuth landing page. The authoritative exchange happens server-side at
 * /api/student/auth/google/callback; this route only reconciles the browser
 * state after the provider redirect and routes into the session-driven flow.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, profile } = useStudentAuth();
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next"));
  const error = params.get("error");

  useEffect(() => {
    if (error) {
      navigate("/login", { replace: true, state: { reason: "oauth_failed" } });
      return;
    }
    if (status === "anonymous") {
      navigate("/login", { replace: true, state: { from: next, reason: "auth_required" } });
      return;
    }
    if (status === "authenticated") {
      if (!profile?.profileCompleted) {
        navigate(`/profile-completion?next=${encodeURIComponent(next)}`, { replace: true });
      } else {
        navigate(next, { replace: true });
      }
    }
  }, [status, profile?.profileCompleted, error, next, navigate]);

  return (
    <div className="login-container">
      <p className="muted">正在確認登入狀態……</p>
    </div>
  );
}
