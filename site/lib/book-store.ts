import { eq, sql } from "drizzle-orm";
import { getDb, D1UnavailableError, isProductionEnvironment } from "../db/index.ts";
import { books } from "../db/schema.ts";
import { syntheticBooks } from "../fixtures/generate.ts";

export type BookItem = {
  id: string;
  title: string;
  description: string;
  totalChapters: number;
  totalPages: number;
  isSynthetic: boolean;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storageState: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
};

export class BookAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`Textbook '${id}' already exists`);
    this.name = "BookAlreadyExistsError";
  }
}

// In-memory fallback store for dev/test environments
const inMemoryBookStore = new Map<string, BookItem>();

function initInMemoryBookStoreIfEmpty() {
  if (inMemoryBookStore.size === 0) {
    for (const b of syntheticBooks) {
      inMemoryBookStore.set(b.id, {
        id: b.id,
        title: b.title,
        description: b.description,
        totalChapters: b.totalChapters,
        totalPages: b.totalPages,
        isSynthetic: true,
        objectKey: `textbooks/${b.id}/synthetic.pdf`,
        contentType: "application/pdf",
        byteSize: 476,
        sha256: "170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736",
        storageState: "active",
        createdAt: b.createdAt,
        updatedAt: b.createdAt,
      });
    }
  }
}

export async function listAllBooks(
  d1Database?: any,
  activeOnly = false
): Promise<BookItem[]> {
  initInMemoryBookStoreIfEmpty();

  try {
    const db = await getDb(d1Database);
    const query = activeOnly
      ? db.select().from(books).where(eq(books.storageState, "active"))
      : db.select().from(books);
    const rows = await query;
    if (rows && rows.length > 0) {
      return rows as BookItem[];
    }
  } catch (err) {
    if (isProductionEnvironment()) {
      throw new D1UnavailableError("D1 database binding 'DB' is unavailable in production");
    }
  }

  const items = Array.from(inMemoryBookStore.values());
  return activeOnly ? items.filter((b) => b.storageState === "active") : items;
}

export async function getBookById(
  id: string,
  d1Database?: any
): Promise<BookItem | null> {
  initInMemoryBookStoreIfEmpty();

  try {
    const db = await getDb(d1Database);
    const rows = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (rows && rows.length > 0) {
      return rows[0] as BookItem;
    }
  } catch (err) {
    if (isProductionEnvironment()) {
      throw new D1UnavailableError("D1 database binding 'DB' is unavailable in production");
    }
  }

  return inMemoryBookStore.get(id) ?? null;
}

export async function saveBookMetadata(
  item: Omit<BookItem, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  },
  d1Database?: any
): Promise<BookItem> {
  initInMemoryBookStoreIfEmpty();

  const now = new Date().toISOString();
  const fullItem: BookItem = {
    ...item,
    createdAt: item.createdAt || now,
    updatedAt: now,
  };

  let persistedToD1 = false;
  try {
    const db = await getDb(d1Database);
    const inserted = await db
      .insert(books)
      .values({
        id: fullItem.id,
        title: fullItem.title,
        description: fullItem.description,
        totalChapters: fullItem.totalChapters,
        totalPages: fullItem.totalPages,
        isSynthetic: fullItem.isSynthetic,
        objectKey: fullItem.objectKey,
        contentType: fullItem.contentType,
        byteSize: fullItem.byteSize,
        sha256: fullItem.sha256,
        storageState: fullItem.storageState,
      })
      .onConflictDoNothing()
      .returning({ id: books.id });
    if (inserted.length === 0) throw new BookAlreadyExistsError(item.id);
    persistedToD1 = true;
  } catch (err) {
    if (err instanceof BookAlreadyExistsError || isProductionEnvironment()) {
      throw err;
    }
  }

  if (!persistedToD1 && inMemoryBookStore.has(item.id)) {
    throw new BookAlreadyExistsError(item.id);
  }
  inMemoryBookStore.set(item.id, fullItem);

  return fullItem;
}

export async function markBookDeleted(
  id: string,
  d1Database?: any
): Promise<{ deleted: boolean; alreadyDeleted?: boolean }> {
  initInMemoryBookStoreIfEmpty();

  const existing = inMemoryBookStore.get(id);
  if (existing) {
    if (existing.storageState === "deleted") {
      return { deleted: true, alreadyDeleted: true };
    }
    existing.storageState = "deleted";
    existing.objectKey = "";
    existing.updatedAt = new Date().toISOString();
  }

  try {
    const db = await getDb(d1Database);
    const rows = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (rows.length > 0 && rows[0].storageState === "deleted") {
      return { deleted: true, alreadyDeleted: true };
    }

    await db
      .update(books)
      .set({
        storageState: "deleted",
        objectKey: "",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(books.id, id));
  } catch (err) {
    if (isProductionEnvironment()) {
      throw err;
    }
  }

  return { deleted: true };
}
