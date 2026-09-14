import { getAuthFromRequest } from "../../auth-helper";

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);

  if (auth.isAuthenticated) {
    return Response.json({
      authenticated: true,
      user: {
        id: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
        role: auth.role,
        isSynthetic: true,
      },
    });
  }

  // Unauthenticated visitor / guest mode with deterministic default synthetic preview
  return Response.json({
    authenticated: false,
    guest: true,
    defaultStudent: {
      id: "student-synth-001",
      email: "student.alice@synthetic.ai-smartbook.test",
      displayName: "測試學生 Alice",
      role: "student",
      isSynthetic: true,
    },
  });
}
