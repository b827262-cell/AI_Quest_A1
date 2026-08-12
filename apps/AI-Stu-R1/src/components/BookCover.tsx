import { useEffect, useState } from "react";
import type { StudentBook } from "../bookDisplay";
import { getBookCategoryName, getBookCoverUrl } from "../bookDisplay";
import { useAppearance } from "../appearance";

/**
 * Book cover that renders coverUrl when present and falls back to a generated
 * book-like cover (title + category + author) when the URL is missing or the
 * image fails to load. Never shows a broken image.
 */
export function BookCover({ book, size = "card" }: { book: StudentBook; size?: "card" | "hero" }) {
  const a = useAppearance();
  const [failed, setFailed] = useState(false);

  // Reset the error state when the cover source changes so a valid cover on the
  // next book is not stuck showing the previous book's fallback.
  useEffect(() => {
    setFailed(false);
  }, [book.coverUrl, book.title]);

  const coverUrl = getBookCoverUrl(book);
  const showImage = !!coverUrl && !failed;

  if (showImage) {
    return (
      <div className={`book-cover ${size}`}>
        <img src={coverUrl} alt={book.title} onError={() => setFailed(true)} />
      </div>
    );
  }

  return (
    <div
      className={`book-cover ${size} fallback fallback-${a.studentFallbackCoverMode}`}
      aria-label={book.title}
    >
      <span className="fc-mark" aria-hidden="true">📖</span>
      <span className="fc-category">{getBookCategoryName(book)}</span>
      <span className="fc-title">{book.title}</span>
    </div>
  );
}
