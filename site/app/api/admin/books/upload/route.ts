import { D1UnavailableError } from "../../../../../db";
import { saveBookMetadata } from "../../../../../lib/book-store";
import {
  getStorageBucket,
  generateBookObjectKey,
  validatePdfBytes,
  calculateSha256,
  R2UnavailableError,
} from "../../../../../lib/storage";
import { getNormalizedAuth } from "../../../auth-helper";
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

export async function POST(request: Request) {
  const cors = handleCors(request);
  if (!cors.isAllowedOrigin) {
    return new Response("CORS Origin Forbidden", { status: 403 });
  }

  // 1. Delegate to Shared Backend if running on frontend proxy
  if (shouldDelegateToBackend(request)) {
    return delegateToBackend(request, "/api/admin/books/upload");
  }

  // 2. Authenticate admin user
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

  // 3. Parse and extract PDF bytes and metadata
  const contentType = request.headers.get("content-type") || "";
  let pdfBytes: Uint8Array;
  let bookId: string | null = null;
  let bookTitle: string | null = null;
  let bookDescription: string = "";

  const reqUrl = new URL(request.url);
  bookId = reqUrl.searchParams.get("id") || reqUrl.searchParams.get("bookId");
  bookTitle = reqUrl.searchParams.get("title");
  bookDescription = reqUrl.searchParams.get("description") || "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return Response.json(
          { error: "missing_file", message: "Multipart field 'file' is required" },
          { status: 400, headers: cors.corsHeaders }
        );
      }
      bookId = (formData.get("id") as string) || (formData.get("bookId") as string) || bookId;
      bookTitle = (formData.get("title") as string) || bookTitle || file.name.replace(/\.pdf$/i, "");
      bookDescription = (formData.get("description") as string) || bookDescription;

      pdfBytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      return Response.json(
        { error: "malformed_multipart", message: (err as Error)?.message || "Failed to parse multipart body" },
        { status: 400, headers: cors.corsHeaders }
      );
    }
  } else if (contentType.includes("application/pdf") || contentType.includes("application/octet-stream")) {
    pdfBytes = new Uint8Array(await request.arrayBuffer());
    bookTitle = bookTitle || request.headers.get("x-book-title");
    bookId = bookId || request.headers.get("x-book-id");
  } else {
    // Attempt to parse JSON body if base64 encoded or fallback to raw buffer
    try {
      const json = await request.clone().json();
      if (json && json.pdfBase64) {
        const binary = atob(json.pdfBase64);
        pdfBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          pdfBytes[i] = binary.charCodeAt(i);
        }
        bookId = json.id || json.bookId || bookId;
        bookTitle = json.title || bookTitle;
        bookDescription = json.description || bookDescription;
      } else {
        pdfBytes = new Uint8Array(await request.arrayBuffer());
      }
    } catch {
      pdfBytes = new Uint8Array(await request.arrayBuffer());
    }
  }

  // Set default bookId and title if missing
  const timestamp = Date.now();
  bookId = bookId ? bookId.trim() : `book-synth-${timestamp.toString(36)}`;
  bookTitle = bookTitle ? bookTitle.trim() : "計算機系統導論 (Synthetic)";

  // 4. Validate PDF bytes
  const validation = validatePdfBytes(pdfBytes);
  if (!validation.valid) {
    return Response.json(
      { error: "invalid_pdf", message: validation.error },
      { status: 400, headers: cors.corsHeaders }
    );
  }

  // 5. Calculate SHA-256
  const sha256 = await calculateSha256(pdfBytes);

  // 6. Connect to R2 bucket
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

  // 7. Store object in R2
  const objectKey = generateBookObjectKey(bookId, "pdf");
  try {
    await bucket.put(objectKey, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        bookId,
        title: bookTitle,
        sha256,
        isSynthetic: "true",
        uploadedBy: auth.user?.id || "admin",
      },
    });
  } catch (err) {
    return Response.json(
      { error: "r2_put_failed", message: (err as Error)?.message || "Failed to put object into R2" },
      { status: 502, headers: cors.corsHeaders }
    );
  }

  // 8. Persist metadata in D1 with compensation
  try {
    await saveBookMetadata({
      id: bookId,
      title: bookTitle,
      description: bookDescription,
      totalChapters: 8,
      totalPages: 160,
      isSynthetic: true,
      objectKey,
      contentType: "application/pdf",
      byteSize: pdfBytes.length,
      sha256,
      storageState: "active",
    });
  } catch (err) {
    // Compensation: delete the orphaned object in R2 if D1 insert fails
    try {
      await bucket.delete(objectKey);
    } catch {
      // Ignore secondary error during cleanup
    }

    if (err instanceof D1UnavailableError) {
      return Response.json(
        { error: "d1_unavailable", message: err.message },
        { status: 503, headers: cors.corsHeaders }
      );
    }
    return Response.json(
      { error: "d1_insert_failed", message: (err as Error)?.message || "Failed to record metadata in D1" },
      { status: 500, headers: cors.corsHeaders }
    );
  }

  const responseHeaders = new Headers(cors.corsHeaders);
  responseHeaders.set("x-data-plane", "shared-backend");

  return Response.json(
    {
      success: true,
      book: {
        id: bookId,
        title: bookTitle,
        description: bookDescription,
        objectKey,
        contentType: "application/pdf",
        byteSize: pdfBytes.length,
        sha256,
        storageState: "active",
        isSynthetic: true,
      },
    },
    { status: 201, headers: responseHeaders }
  );
}
