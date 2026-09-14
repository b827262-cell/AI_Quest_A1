import { D1UnavailableError } from "../../../../../db";
import { getBookById } from "../../../../../lib/book-store";
import {
  handleCors,
  shouldDelegateToBackend,
  delegateToBackend,
} from "../../../backend-client";

type RouteParams = {
  params: Promise<{ id: string }> | { id: string };
};

export async function OPTIONS(request: Request) {
  const cors = handleCors(request);
  if (cors.preflightResponse) return cors.preflightResponse;
  return new Response(null, { status: 204, headers: cors.corsHeaders });
}

export async function GET(request: Request, context: RouteParams) {
  const params = await Promise.resolve(context.params);
  const id = params?.id;

  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return new Response("CORS Origin Forbidden", { status: 403 });
  }

  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, `/api/student/books/${id}`);
  }

  try {
    const b = await getBookById(id);

    if (!b || b.storageState === "deleted") {
      return Response.json(
        { error: "book_not_found", message: `Textbook '${id}' not found` },
        { status: 404, headers: cors.corsHeaders }
      );
    }

    const responseHeaders = new Headers(cors.corsHeaders);
    responseHeaders.set("x-data-plane", "shared-backend");

    return Response.json(
      {
        book: {
          id: b.id,
          title: b.title,
          description: b.description,
          totalChapters: b.totalChapters,
          totalPages: b.totalPages,
          contentType: b.contentType,
          byteSize: b.byteSize,
          sha256: b.sha256,
          isSynthetic: b.isSynthetic,
        },
      },
      { status: 200, headers: responseHeaders }
    );
  } catch (err) {
    if (err instanceof D1UnavailableError) {
      return Response.json(
        { error: "d1_unavailable", message: err.message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "query_failed", message: (err as Error)?.message },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}
