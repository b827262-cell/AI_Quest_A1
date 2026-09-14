import { D1UnavailableError } from "../../../../db";
import {
  deleteObjectWithVerification,
  getStorageBucket,
  restoreStorageObject,
  R2UnavailableError,
} from "../../../../lib/storage";
import {
  listAllBooks,
  getBookById,
  markBookDeleted,
} from "../../../../lib/book-store";
import { getNormalizedAuth } from "../../auth-helper";
import {
  handleCors,
  shouldDelegateToBackend,
  delegateToBackend,
} from "../../backend-client";
import { POST as handleUploadPost } from "./upload/route";

export async function OPTIONS(request: Request) {
  const cors = handleCors(request);
  if (cors.preflightResponse) return cors.preflightResponse;
  return new Response(null, { status: 204, headers: cors.corsHeaders });
}

export async function POST(request: Request) {
  return handleUploadPost(request);
}

export async function GET(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return new Response("CORS Origin Forbidden", { status: 403 });
  }

  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/admin/books");
  }

  const auth = getNormalizedAuth(request);
  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 400, headers: cors.corsHeaders }
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

  const reqUrl = new URL(request.url);
  const singleId = reqUrl.searchParams.get("id");

  try {
    if (singleId) {
      const book = await getBookById(singleId);
      if (!book) {
        return Response.json(
          { error: "book_not_found", message: `Textbook '${singleId}' not found` },
          { status: 404, headers: cors.corsHeaders }
        );
      }
      const responseHeaders = new Headers(cors.corsHeaders);
      responseHeaders.set("x-data-plane", "shared-backend");
      return Response.json({ book }, { status: 200, headers: responseHeaders });
    }

    const allBooks = await listAllBooks();
    const responseHeaders = new Headers(cors.corsHeaders);
    responseHeaders.set("x-data-plane", "shared-backend");
    return Response.json({ books: allBooks }, { status: 200, headers: responseHeaders });
  } catch (err) {
    if (err instanceof D1UnavailableError) {
      return Response.json(
        { error: "d1_unavailable", message: err.message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "internal_error", message: (err as Error)?.message || "Failed to query books" },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}

export async function DELETE(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return new Response("CORS Origin Forbidden", { status: 403 });
  }

  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/admin/books");
  }

  const auth = getNormalizedAuth(request);
  if (auth.isMalformed) {
    return Response.json(
      { error: "malformed_auth", message: auth.malformedReason },
      { status: 400, headers: cors.corsHeaders }
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

  const reqUrl = new URL(request.url);
  const targetId = reqUrl.searchParams.get("id");
  if (!targetId) {
    return Response.json(
      { error: "missing_id", message: "Query parameter 'id' is required for DELETE" },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  try {
    const book = await getBookById(targetId);

    if (!book) {
      return Response.json(
        { error: "book_not_found", message: `Book '${targetId}' not found` },
        { status: 404, headers: cors.corsHeaders }
      );
    }

    // Check if already deleted (idempotent delete)
    if (book.storageState === "deleted") {
      const responseHeaders = new Headers(cors.corsHeaders);
      responseHeaders.set("x-data-plane", "shared-backend");
      return Response.json(
        {
          success: true,
          alreadyDeleted: true,
          id: targetId,
          storageState: "deleted",
        },
        { status: 200, headers: responseHeaders }
      );
    }

    // 1. Physically delete the R2 object and retain bytes for D1 compensation.
    let bucket: Awaited<ReturnType<typeof getStorageBucket>> | undefined;
    let deletedObject: Awaited<ReturnType<typeof deleteObjectWithVerification>> = null;
    if (book.objectKey) {
      try {
        bucket = await getStorageBucket();
        deletedObject = await deleteObjectWithVerification(bucket, book.objectKey);
      } catch (err) {
        if (err instanceof R2UnavailableError) {
          return Response.json(
            { error: "r2_unavailable", message: err.message },
            { status: 503, headers: cors.corsHeaders }
          );
        }
        return Response.json(
          { error: "r2_delete_failed", message: (err as Error)?.message || "Failed to delete R2 object" },
          { status: 502, headers: cors.corsHeaders }
        );
      }
      if (!deletedObject) {
        return Response.json(
          { error: "object_not_found", message: `Storage object for book '${targetId}' was not found` },
          { status: 404, headers: cors.corsHeaders }
        );
      }
    }

    // 2. Mark deleted in D1. Restore R2 if the metadata update fails.
    try {
      await markBookDeleted(targetId);
    } catch (err) {
      let compensated = false;
      if (book.objectKey && bucket && deletedObject) {
        try {
          await restoreStorageObject(bucket, book.objectKey, deletedObject);
          compensated = true;
        } catch {
          // The response records failed compensation without masking the D1 failure.
        }
      }
      const status = err instanceof D1UnavailableError ? 503 : 500;
      return Response.json(
        {
          error: err instanceof D1UnavailableError ? "d1_unavailable" : "d1_delete_failed",
          message: (err as Error)?.message || "Failed to mark book deleted",
          r2Compensated: compensated,
        },
        { status, headers: cors.corsHeaders }
      );
    }

    const responseHeaders = new Headers(cors.corsHeaders);
    responseHeaders.set("x-data-plane", "shared-backend");

    return Response.json(
      {
        success: true,
        deleted: true,
        id: targetId,
        storageState: "deleted",
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
      { error: "delete_failed", message: (err as Error)?.message || "Failed to delete book" },
      { status: 500, headers: cors.corsHeaders }
    );
  }
}
