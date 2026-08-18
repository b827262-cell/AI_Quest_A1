import { Link } from "react-router-dom";
import type { StudentBook } from "../bookDisplay";
import { getBookAuthorName, getBookCoverUrl } from "../bookDisplay";

/**
 * Reader-specific top bar (below the global StudentHeader). Compact: back link,
 * chat-history toggle, small cover + title + author, and a points pill. It does
 * not reuse the homepage's large book-card layout.
 */
export function ReaderTopBar({
  book,
  onToggleHistory
}: {
  book: StudentBook;
  onToggleHistory: () => void;
}) {
  const cover = getBookCoverUrl(book);

  return (
    <div className="reader-topbar">
      <div className="reader-topbar-left">
        <Link className="reader-back" to="/books">
          ← 返回
        </Link>
        <button type="button" className="reader-history-btn" onClick={onToggleHistory}>
          歷史對話
        </button>
      </div>

      <div className="reader-topbar-center">
        <div className="reader-mini-cover" aria-hidden="true">
          {cover ? <img src={cover} alt="" /> : <span>{book.title.charAt(0)}</span>}
        </div>
        <div className="reader-mini-meta">
          <strong title={book.title}>{book.title}</strong>
          <span>{getBookAuthorName(book)}</span>
        </div>
      </div>

      <div className="reader-topbar-right">
        <span className="student-points">
          <strong>0</strong> 點
        </span>
      </div>
    </div>
  );
}
