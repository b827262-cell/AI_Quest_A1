import { getNormalizedAuth } from "../../auth-helper";
import { isProductionEnvironment } from "../../../../db";
import {
  shouldDelegateToBackend,
  delegateToBackend,
  handleCors,
} from "../../backend-client";

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

  // If running on Student frontend in production, delegate to Shared Backend
  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/student/me");
  }

  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  if (auth.isAuthenticated) {
    return Response.json(
      {
        authenticated: true,
        user: auth.user,
        role: auth.role,
        isSynthetic: auth.isSynthetic,
      },
      {
        headers: {
          ...cors.corsHeaders,
          "x-data-plane": "shared-backend",
        },
      }
    );
  }

  // In production without demo mode, guests have no synthetic user identity
  if (isProductionEnvironment() && !auth.isDemo) {
    return Response.json(
      {
        authenticated: false,
        guest: true,
        user: null,
      },
      {
        headers: cors.corsHeaders,
      }
    );
  }

  // Dev / test / demo mode preview
  return Response.json(
    {
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
    },
    {
      headers: cors.corsHeaders,
    }
  );
}
