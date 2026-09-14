import { getNormalizedAuth } from "../../auth-helper";
import { isProductionEnvironment } from "../../../../db";

export async function GET(request: Request) {
  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401 }
    );
  }

  if (auth.isAuthenticated) {
    return Response.json({
      authenticated: true,
      user: auth.user,
      role: auth.role,
      isSynthetic: auth.isSynthetic,
    });
  }

  // In production without demo mode, guests have no synthetic user identity
  if (isProductionEnvironment() && !auth.isDemo) {
    return Response.json({
      authenticated: false,
      guest: true,
      user: null,
    });
  }

  // Dev / test / demo mode preview
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
    isDemo: true,
  });
}
