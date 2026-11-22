// Security test fixtures - concurrency verification data.
// Parallel 401 and single-logout scenarios.

export const CONCURRENT_401_REQUESTS = [
  { path: "/api/admin/courses", method: "GET", token: "0000000000000000000000000000000000000000.expired.example.invalid" },
  { path: "/api/admin/courses", method: "GET", token: "0000000000000000000000000000000000000000.revoked.example.invalid" },
  { path: "/api/admin/courses", method: "GET", token: "not-a-token.example.invalid" },
  { path: "/api/admin/courses", method: "GET", token: "" },
  { path: "/api/admin/courses", method: "GET", token: null }
];

export const CONCURRENT_401_EXPECTED_STATUS = 401;

export const LOGOUT_SESSIONS = [
  { sessionId: "sess-001@example.invalid", token: "0000000000000000000000000000000000000000.valid.example.invalid", user: "admin-001@example.invalid" },
  { sessionId: "sess-002@example.invalid", token: "0000000000000000000000000000000000000000.valid.example.invalid", user: "teacher-001@example.invalid" },
  { sessionId: "sess-003@example.invalid", token: "0000000000000000000000000000000000000000.valid.example.invalid", user: "student-001@example.invalid" }
];

export const LOGOUT_EXPECTED = {
  before: { authenticated: true, sessionValid: true },
  after: { authenticated: false, sessionValid: false, tokenRejected: true }
};

export function logoutScenario(session) {
  return {
    sessionId: session.sessionId,
    token: session.token,
    user: session.user,
    revokePath: `/api/auth/sessions/${session.sessionId}/revoke`,
    verifyPath: `/api/auth/sessions/${session.sessionId}/verify`
  };
}
