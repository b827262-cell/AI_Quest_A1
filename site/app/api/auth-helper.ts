export type AuthContext = {
  isAuthenticated: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: "admin" | "student" | "guest";
  isDemo: boolean;
};

export function getAuthFromRequest(request: Request): AuthContext {
  const headers = request.headers;
  const isProd = process.env.NODE_ENV === "production";
  const demoHeader = headers.get("x-demo-mode") === "true";
  const userId = headers.get("oai-authenticated-user-id");
  const email = headers.get("oai-authenticated-user-email");
  const roleHeader = headers.get("oai-authenticated-user-role");
  const adminKey = headers.get("x-admin-key");

  let displayName: string | null = null;
  const rawFullName = headers.get("oai-authenticated-user-full-name");
  const encoding = headers.get("oai-authenticated-user-full-name-encoding");
  if (rawFullName) {
    displayName = encoding === "percent-encoded-utf-8" ? decodeURIComponent(rawFullName) : rawFullName;
  } else if (email) {
    displayName = email;
  }

  // 1. Unauthenticated
  if (!userId && !email && !adminKey) {
    return {
      isAuthenticated: false,
      userId: null,
      email: null,
      displayName: null,
      role: "guest",
      isDemo: demoHeader || !isProd,
    };
  }

  // 2. Role determination
  let role: "admin" | "student" = "student";
  if (
    roleHeader === "admin" ||
    adminKey === "synthetic-admin-secret" ||
    (email && (email.includes("admin") || email === "admin.tester@synthetic.ai-smartbook.test"))
  ) {
    role = "admin";
  }

  return {
    isAuthenticated: true,
    userId: userId ?? (role === "admin" ? "admin-synth-001" : "student-synth-001"),
    email: email ?? (role === "admin" ? "admin.tester@synthetic.ai-smartbook.test" : "student.alice@synthetic.ai-smartbook.test"),
    displayName: displayName ?? (role === "admin" ? "合成管理員" : "測試學生 Alice"),
    role,
    isDemo: demoHeader || !isProd,
  };
}
