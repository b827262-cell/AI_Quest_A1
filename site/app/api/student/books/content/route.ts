import { D1UnavailableError } from "../../../../../db";
import { getStorageBucket, R2UnavailableError } from "../../../../../lib/storage";
import { getBookById } from "../../../../../lib/book-store";
import {
  handleCors,
  shouldDelegateToBackend,
  delegateToBackend,
} from "../../../backend-client";

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

  const reqUrl = new URL(request.url);
  const id = reqUrl.searchParams.get("id") || reqUrl.searchParams.get("bookId");

  if (!id) {
    return Response.json(
      { error: "missing_id", message: "Query parameter 'id' or 'bookId' is required" },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, `/api/student/books/content?id=${encodeURIComponent(id)}`);
  }

  try {
    const book = await getBookById(id);

    if (!book || book.storageState === "deleted") {
      return Response.json(
        { error: "book_not_found", message: `Textbook '${id}' not found or deleted` },
        { status: 404, headers: cors.corsHeaders }
      );
    }

    if (!book.objectKey) {
      return Response.json(
        { error: "content_not_available", message: `No object storage key associated with book '${id}'` },
        { status: 404, headers: cors.corsHeaders }
      );
    }

    let bucket: any;
    try {
      bucket = await getStorageBucket();
    } catch (err) {
      if (err instanceof R2UnavailableError) {
        return Response.json(
          { error: "r2_unavailable", message: err.message },
          { status: 503, headers: cors.corsHeaders }
        );
      }
      throw err;
    }

    const object = await bucket.get(book.objectKey);
    if (!object) {
      return Response.json(
        { error: "object_not_found", message: `Storage object for book '${id}' was not found in bucket` },
        { status: 404, headers: cors.corsHeaders }
      );
    }

    const headers = new Headers(cors.corsHeaders);
    headers.set("content-type", book.contentType || "application/pdf");
    headers.set("content-length", object.size.toString());
    if (object.httpEtag) {
      headers.set("etag", object.httpEtag);
    }
    headers.set("x-book-id", book.id);
    if (book.sha256) {
      headers.set("x-sha256", book.sha256);
    }
    headers.set("x-data-plane", "shared-backend");
    headers.set("content-disposition", `inline; filename="${book.id}.pdf"`);

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    if (err instanceof D1UnavailableError) {
      return Response.json(
        { error: "d1_unavailable", message: err.message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "content_fetch_failed", message: (err as Error)?.message },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}
