import { getAuthFromRequest } from "../../auth-helper";
import { getStudentProgress, saveStudentProgress } from "../../../../lib/progress-store";
import { D1UnavailableError, isProductionEnvironment } from "../../../../db";

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);
  const studentId = auth.userId ?? "student-synth-001";

  try {
    const result = await getStudentProgress(studentId);
    return Response.json({
      studentId,
      source: result.source,
      progress: result.progress,
      authenticated: auth.isAuthenticated,
    });
  } catch (error) {
    if (error instanceof D1UnavailableError || (error as Error)?.name === "D1UnavailableError") {
      return Response.json(
        { error: "database_unavailable", message: (error as Error).message },
        { status: 503 }
      );
    }
    return Response.json({ error: "internal_error", message: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = getAuthFromRequest(request);

  // In production, unauthenticated requests must never silently update synthetic data
  if (!auth.isAuthenticated && isProductionEnvironment() && !auth.isDemo) {
    return Response.json(
      { error: "unauthorized", message: "Authentication required to update progress" },
      { status: 401 }
    );
  }

  const studentId = auth.userId ?? "student-synth-001";

  let body: {
    bookId?: string;
    progressPercent?: number;
    lastReadChapter?: string | null;
    lastReadPage?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json", message: "Malformed JSON body" }, { status: 400 });
  }

  if (!body.bookId || typeof body.bookId !== "string") {
    return Response.json({ error: "invalid_input", message: "bookId is required" }, { status: 400 });
  }

  if (
    typeof body.progressPercent !== "number" ||
    isNaN(body.progressPercent) ||
    body.progressPercent < 0 ||
    body.progressPercent > 100
  ) {
    return Response.json(
      { error: "invalid_input", message: "progressPercent must be a number between 0 and 100" },
      { status: 400 }
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

    return Response.json({
      success: true,
      updated,
    });
  } catch (error) {
    if (error instanceof D1UnavailableError || (error as Error)?.name === "D1UnavailableError") {
      return Response.json(
        { error: "database_unavailable", message: (error as Error).message },
        { status: 503 }
      );
    }
    return Response.json({ error: "internal_error", message: (error as Error).message }, { status: 500 });
  }
}
