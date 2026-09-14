import { getNormalizedAuth } from "../../auth-helper";
import { getStudentProgress, saveStudentProgress } from "../../../../lib/progress-store";
import { D1UnavailableError, isProductionEnvironment } from "../../../../db";
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
    return delegateToBackend(request, "/api/student/progress");
  }

  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  // In production without authentication and not in demo mode, return guest empty progress
  if (!auth.isAuthenticated && isProductionEnvironment() && !auth.isDemo) {
    return Response.json(
      {
        authenticated: false,
        guest: true,
        studentId: null,
        progress: [],
      },
      { headers: cors.corsHeaders }
    );
  }

  const studentId = auth.user?.id ?? "student-synth-001";

  try {
    const result = await getStudentProgress(studentId);
    return Response.json(
      {
        studentId,
        source: result.source,
        progress: result.progress,
        authenticated: auth.isAuthenticated,
      },
      {
        headers: {
          ...cors.corsHeaders,
          "x-data-plane": "shared-backend",
        },
      }
    );
  } catch (error) {
    if (error instanceof D1UnavailableError || (error as Error)?.name === "D1UnavailableError") {
      return Response.json(
        { error: "database_unavailable", message: (error as Error).message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "internal_error", message: (error as Error).message },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}

export async function PUT(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return Response.json({ error: "cors_forbidden", message: "Origin not allowed" }, { status: 403 });
  }

  // If running on Student frontend in production, delegate to Shared Backend
  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/student/progress");
  }

  const auth = getNormalizedAuth(request);

  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  // In production, unauthenticated requests must never silently update synthetic data
  if (!auth.isAuthenticated && isProductionEnvironment() && !auth.isDemo) {
    return Response.json(
      { error: "unauthorized", message: "Authentication required to update progress" },
      { status: 401, headers: cors.corsHeaders }
    );
  }

  const studentId = auth.user?.id ?? "student-synth-001";

  let body: {
    bookId?: string;
    progressPercent?: number;
    lastReadChapter?: string | null;
    lastReadPage?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Malformed JSON body" },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  if (!body.bookId || typeof body.bookId !== "string") {
    return Response.json(
      { error: "invalid_input", message: "bookId is required" },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  if (
    typeof body.progressPercent !== "number" ||
    isNaN(body.progressPercent) ||
    body.progressPercent < 0 ||
    body.progressPercent > 100
  ) {
    return Response.json(
      { error: "invalid_input", message: "progressPercent must be a number between 0 and 100" },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  try {
    const updated = await saveStudentProgress({
      studentId,
      bookId: body.bookId,
      progressPercent: Math.round(body.progressPercent),
      lastReadChapter: body.lastReadChapter,
      lastReadPage: body.lastReadPage ?? 1,
    });

    return Response.json(
      {
        success: true,
        updated,
      },
      {
        headers: {
          ...cors.corsHeaders,
          "x-data-plane": "shared-backend",
        },
      }
    );
  } catch (error) {
    if (error instanceof D1UnavailableError || (error as Error)?.name === "D1UnavailableError") {
      return Response.json(
        { error: "database_unavailable", message: (error as Error).message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "internal_error", message: (error as Error).message },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}
