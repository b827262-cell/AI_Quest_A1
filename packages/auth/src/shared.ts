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
