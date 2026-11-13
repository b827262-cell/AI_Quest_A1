import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { StudentProfile, StudentUser } from "@ai-smartbook/auth/browser";
import { resetStudentUnauthorizedNotification, setStudentUnauthorizedHandler, studentClient } from "./studentClient";

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
  const logoutInFlightRef = useRef(false);
  const invalidatedRef = useRef(false);

  const clearAuthState = useCallback(() => {
    setUser(null);
    setProfile(null);
    setStatus("anonymous");
  }, []);

  const handleUnauthorized = useCallback(() => {
    if (logoutInFlightRef.current || invalidatedRef.current) return;
    invalidatedRef.current = true;
    clearAuthState();
    navigate("/login", { replace: true, state: { reason: "session_expired" } });
  }, [clearAuthState, navigate]);

  useEffect(() => {
    setStudentUnauthorizedHandler(handleUnauthorized);
    return () => setStudentUnauthorizedHandler(null);
  }, [handleUnauthorized]);

  const refresh = useCallback(async () => {
    if (logoutInFlightRef.current || invalidatedRef.current) return;
    try {
      const result = await studentClient.getStudentMe();
      if (logoutInFlightRef.current || invalidatedRef.current) return;
      setUser(result.user);
      setProfile(result.profile);
      if (result.authenticated) {
        invalidatedRef.current = false;
        resetStudentUnauthorizedNotification();
        setStatus("authenticated");
      } else {
        invalidatedRef.current = true;
        setStatus("anonymous");
      }
    } catch {
      if (logoutInFlightRef.current || invalidatedRef.current) return;
      setUser(null);
      setProfile(null);
      invalidatedRef.current = true;
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    invalidatedRef.current = true;
    try {
      await studentClient.logoutStudent();
    } finally {
      clearAuthState();
      navigate("/login", { replace: true });
    }
  }, [clearAuthState, navigate]);

  const updateProfile = useCallback(async (input: { displayName: string; schoolName: string; gradeLevel: string }) => {
    if (logoutInFlightRef.current || invalidatedRef.current) {
      throw new Error("student session is not active");
    }
    const result = await studentClient.updateStudentProfile(input);
    if (logoutInFlightRef.current || invalidatedRef.current) {
      throw new Error("student session is not active");
    }
    setProfile(result.profile);
    setUser(result.profile);
    invalidatedRef.current = false;
    resetStudentUnauthorizedNotification();
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
    return <Navigate to={`/profile-completion?next=${encodeURIComponent(next)}`} replace state={{ reason: "profile_incomplete" }} />;
  }
  return <>{children}</>;
}
