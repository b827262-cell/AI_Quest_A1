export type Role = "student" | "admin" | "teacher" | "super_admin";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface GoogleOAuthAdapter {
  getAuthUrl(): string;
  verifyCallback(code: string): Promise<AuthUser>;
}

/**
 * @deprecated TODO: Unimplemented stub. This function is not a functioning
 * access control guard and unconditionally returns true.
 */
export function requireRole(_role: Role) {
  return true;
}
