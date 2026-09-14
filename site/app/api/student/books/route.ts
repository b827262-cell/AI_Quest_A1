import { D1UnavailableError } from "../../../../db";
import { listAllBooks, getBookById } from "../../../../lib/book-store";
import {
  handleCors,
  shouldDelegateToBackend,
  delegateToBackend,
} from "../../backend-client";

export async function OPTIONS(request: Request) {
  const cors = handleCors(request);
  if (cors.preflightResponse) return cors.preflightResponse;
  return new Response(null, { status: 204, headers: cors.corsHeaders });
}

export async function GET(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return new Response("CORS Origin Forbidden", { status: 403 });
  }

  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/student/books");
  }

  const reqUrl = new URL(request.url);
  const singleId = reqUrl.searchParams.get("id");

  try {
    if (singleId) {
      const b = await getBookById(singleId);

      if (!b || b.storageState === "deleted") {
        return Response.json(
          { error: "book_not_found", message: `Textbook '${singleId}' not found` },
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
    }

    const rows = await listAllBooks(undefined, true);

    const sanitizedBooks = rows.map((b) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      totalChapters: b.totalChapters,
      totalPages: b.totalPages,
      contentType: b.contentType,
      byteSize: b.byteSize,
      sha256: b.sha256,
      isSynthetic: b.isSynthetic,
    }));

    const responseHeaders = new Headers(cors.corsHeaders);
    responseHeaders.set("x-data-plane", "shared-backend");

    return Response.json(
      { books: sanitizedBooks },
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
