export interface StudentUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  profileCompleted: boolean;
}

export interface StudentProfile extends StudentUser {
  schoolName: string | null;
  gradeLevel: string | null;
}

export interface StudentSession {
  id: string;
  userId: string;
  expiresAt: string;
}

export type StudentAuthErrorCode =
  | "AUTH_REQUIRED"
  | "SESSION_EXPIRED"
  | "OAUTH_STATE_INVALID"
  | "OAUTH_PROVIDER_ERROR"
  | "PROFILE_INCOMPLETE";

export type StudentRedirectReason = "auth_required" | "session_expired" | "profile_incomplete";

export interface StudentAuthMeResponse {
  authenticated: boolean;
  user: StudentUser | null;
  profile: StudentProfile | null;
  redirectReason?: StudentRedirectReason;
}

/**
 * A return location is always an application-relative learning route. This is
 * intentionally browser-safe so every client transition and the server OAuth
 * boundary apply the same open-redirect policy.
 */
export function safeStudentReturnTo(value: string | null | undefined, fallback = "/books"): string {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\r\n]/.test(candidate)) {
    return fallback;
  }
  return candidate;
}
