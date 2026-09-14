import { getNormalizedAuth } from "../../../auth-helper";

export async function GET(request: Request) {
  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401 }
    );
  }

  if (!auth.isAuthenticated) {
    return Response.json(
      { error: "admin authentication required", authenticated: false },
      { status: 401 }
    );
  }

  if (auth.role !== "admin") {
    return Response.json(
      { error: "admin permission required", authenticated: true, role: auth.role },
      { status: 403 }
    );
  }

  return Response.json({
    authenticated: true,
    role: "admin",
    user: auth.user,
  });
}
