import { isProductionEnvironment } from "../db/index.ts";

export class R2UnavailableError extends Error {
  constructor(message = "Cloudflare R2 binding `BOOKS_BUCKET` is unavailable.") {
    super(message);
    this.name = "R2UnavailableError";
  }
}

/**
 * In-memory mock R2 bucket for local dev/test when real Cloudflare R2 is not bound.
 */
export class InMemoryR2Bucket {
  private objects = new Map<
    string,
    { body: Uint8Array; httpMetadata?: any; customMetadata?: any; etag: string }
  >();

  async put(key: string, value: any, options?: any) {
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value && typeof value.arrayBuffer === "function") {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else {
      bytes = new Uint8Array(0);
    }
    const etag = `mock-etag-${Date.now()}`;
    this.objects.set(key, {
      body: bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      etag,
    });
    return {
      key,
      size: bytes.length,
      etag,
      httpEtag: `"${etag}"`,
    };
  }

  async get(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      size: item.body.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
      body: new Response(item.body).body,
      arrayBuffer: async () => item.body.buffer,
    };
  }

  async head(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      size: item.body.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  clear() {
    this.objects.clear();
  }
}

/**
 * Retrieves the Cloudflare R2 bucket binding.
 * Throws R2UnavailableError in production if BOOKS_BUCKET is not accessible.
 */
export async function getStorageBucket(r2Bucket?: any): Promise<any> {
  let targetBucket = r2Bucket;
  if (!targetBucket) {
    try {
      // Dynamic import to avoid module loader crash in non-workerd environments
      // @ts-ignore
      const cf = await import("cloudflare:workers");
      targetBucket = cf?.env?.BOOKS_BUCKET;
    } catch {
      // Running in Node.js test environment or workerd without cloudflare:workers
    }
  }

  if (!targetBucket) {
    targetBucket =
      (globalThis as any)?.BOOKS_BUCKET ||
      (globalThis as any)?.__env__?.BOOKS_BUCKET ||
      (globalThis as any)?.env?.BOOKS_BUCKET;
  }

  if (!targetBucket) {
    if (isProductionEnvironment()) {
      throw new R2UnavailableError(
        "Cloudflare R2 binding `BOOKS_BUCKET` is unavailable. Ensure `r2` is set to `BOOKS_BUCKET` in .openai/hosting.json."
      );
    }
    const g = globalThis as any;
    if (!g.__inMemoryR2Store) {
      g.__inMemoryR2Store = new InMemoryR2Bucket();
    }
    targetBucket = g.__inMemoryR2Store;
  }

  return targetBucket;
}

/**
 * Generates a collision-resistant, server-side object key for a textbook file.
 * Prevents client-controlled path traversal.
 */
export function generateBookObjectKey(bookId: string, extension: string = "pdf"): string {
  const safeBookId = (bookId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
  const timestamp = Date.now();
  const randomHex = Math.random().toString(36).substring(2, 10);
  return `textbooks/${safeBookId}/${timestamp}-${randomHex}.${extension}`;
}

/**
 * Validates uploaded bytes to guarantee:
 * 1. Non-empty
 * 2. Within size limit (default 15MB)
 * 3. PDF signature magic bytes (%PDF-)
 */
export function validatePdfBytes(
  buffer: Uint8Array,
  maxSizeBytes: number = 15 * 1024 * 1024
): { valid: boolean; error?: string } {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: "Empty file body: uploaded PDF has 0 bytes" };
  }

  if (buffer.length > maxSizeBytes) {
    return {
      valid: false,
      error: `File size exceeds allowed limit of ${maxSizeBytes} bytes (received ${buffer.length} bytes)`,
    };
  }

  // Verify magic bytes: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (buffer.length < 5) {
    return { valid: false, error: "File too small to be a valid PDF" };
  }

  const header = String.fromCharCode(...buffer.slice(0, 5));
  if (header !== "%PDF-") {
    return {
      valid: false,
      error: "Invalid file format: missing %PDF- header signature",
    };
  }

  return { valid: true };
}

/**
 * Calculates SHA-256 hex digest of a byte buffer.
 */
export async function calculateSha256(buffer: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type StoredObjectSnapshot = {
  body: Uint8Array;
  httpMetadata?: unknown;
  customMetadata?: unknown;
};

/**
 * Deletes an existing object and confirms that R2 no longer returns metadata for it.
 * The returned snapshot can be used to compensate if the following D1 update fails.
 */
export async function deleteObjectWithVerification(
  bucket: Awaited<ReturnType<typeof getStorageBucket>>,
  objectKey: string
): Promise<StoredObjectSnapshot | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;

  const snapshot: StoredObjectSnapshot = {
    body: new Uint8Array(await object.arrayBuffer()),
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  };

  await bucket.delete(objectKey);
  const remaining =
    typeof bucket.head === "function"
      ? await bucket.head(objectKey)
      : await bucket.get(objectKey);
  if (remaining) {
    throw new Error(`R2 object '${objectKey}' still exists after deletion`);
  }

  return snapshot;
}

/** Restores a previously deleted object when the corresponding D1 update fails. */
export async function restoreStorageObject(
  bucket: Awaited<ReturnType<typeof getStorageBucket>>,
  objectKey: string,
  snapshot: StoredObjectSnapshot
): Promise<void> {
  await bucket.put(objectKey, snapshot.body, {
    httpMetadata: snapshot.httpMetadata,
    customMetadata: snapshot.customMetadata,
  });
}
