import { getNormalizedAuth } from "../../../auth-helper";
import {
  shouldDelegateToBackend,
  delegateToBackend,
  handleCors,
} from "../../../backend-client";

export async function OPTIONS(request: Request) {
  const cors = handleCors(request);
  if (cors.preflightResponse) return cors.preflightResponse;
  return new Response(null, { status: 204, headers: cors.corsHeaders });
}

export async function GET(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return Response.json({ error: "cors_forbidden", message: "Origin not allowed" }, { status: 403 });
  }

  // If running on Admin frontend in production, delegate to Shared Backend
  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/admin/auth/me");
  }

  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  if (!auth.isAuthenticated) {
    return Response.json(
      { error: "admin authentication required", authenticated: false },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  if (auth.role !== "admin") {
    return Response.json(
      { error: "admin permission required", authenticated: true, role: auth.role },
      { status: 403, headers: cors.corsHeaders }
    );
  }

  return Response.json(
    {
      authenticated: true,
      role: "admin",
      user: auth.user,
    },
    {
      headers: {
        ...cors.corsHeaders,
        "x-data-plane": "shared-backend",
      },
    }
  );
}
