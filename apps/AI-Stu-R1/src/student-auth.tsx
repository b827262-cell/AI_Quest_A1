import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { StudentProfile, StudentUser } from "@ai-smartbook/auth/browser";
import { studentClient } from "./studentClient";

type StudentAuthStatus = "loading" | "authenticated" | "anonymous";

interface StudentAuthContextValue {
  status: StudentAuthStatus;
  user: StudentUser | null;
  profile: StudentProfile | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (input: { displayName: string; schoolName: string; gradeLevel: string }) => Promise<StudentProfile>;
}

const StudentAuthContext = createContext<StudentAuthContextValue | null>(null);

export function StudentAuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StudentAuthStatus>("loading");
  const [user, setUser] = useState<StudentUser | null>(null);
  const [profile, setProfile] = useState<StudentProfile | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await studentClient.getStudentMe();
      setUser(result.user);
      setProfile(result.profile);
      setStatus(result.authenticated ? "authenticated" : "anonymous");
    } catch {
      setUser(null);
      setProfile(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await studentClient.logoutStudent();
    } finally {
      setUser(null);
      setProfile(null);
      setStatus("anonymous");
      navigate("/login", { replace: true });
    }
  }, [navigate]);

  const updateProfile = useCallback(async (input: { displayName: string; schoolName: string; gradeLevel: string }) => {
    const result = await studentClient.updateStudentProfile(input);
    setProfile(result.profile);
    setUser(result.profile);
    setStatus("authenticated");
    return result.profile;
  }, []);

  const value = useMemo(
    () => ({ status, user, profile, refresh, logout, updateProfile }),
    [status, user, profile, refresh, logout, updateProfile]
  );
  return <StudentAuthContext.Provider value={value}>{children}</StudentAuthContext.Provider>;
}

export function useStudentAuth(): StudentAuthContextValue {
  const value = useContext(StudentAuthContext);
  if (!value) throw new Error("useStudentAuth must be used within StudentAuthProvider");
  return value;
}

export function RequireStudent({ children }: { children: ReactNode }) {
  const { status, profile } = useStudentAuth();
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;
  if (status === "loading") return <div className="login-container"><p className="muted">正在驗證學員登入狀態……</p></div>;
  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: next, reason: "auth_required" }} />;
  }
  if (!profile?.profileCompleted) {
    return <Navigate to={`/profile/complete?next=${encodeURIComponent(next)}`} replace state={{ reason: "profile_incomplete" }} />;
  }
  return <>{children}</>;
}
