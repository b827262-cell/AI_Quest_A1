import type { Book } from "@ai-smartbook/schema";
import { Link } from "react-router-dom";
import { getBookAuthorName, getBookCategoryName } from "../../bookDisplay";
import { BookCover } from "../BookCover";

export type DashboardResourceStatus = "loading" | "success" | "error";

interface SmartBookSectionProps {
  books: Book[];
  status: DashboardResourceStatus;
  error: string | null;
  onRetry: () => void;
}

function LoadingCards() {
  return (
    <div className="dashboard-book-grid" aria-label="SmartBook 載入中" aria-busy="true">
      {["one", "two", "three", "four"].map((key) => (
        <div className="dashboard-book-skeleton" key={key}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function SmartBookCard({ book }: { book: Book }) {
  return (
    <Link className="dashboard-book-card" to={`/books/${book.id}`}>
      <BookCover book={book} />
      <span className="dashboard-book-category">{getBookCategoryName(book)}</span>
      <strong className="dashboard-book-title">{book.title}</strong>
      <span className="dashboard-book-author">{getBookAuthorName(book)}</span>
    </Link>
  );
}

export function SmartBookSection({ books, status, error, onRetry }: SmartBookSectionProps) {
  return (
    <section className="dashboard-panel dashboard-smartbook" aria-labelledby="smartbook-heading">
      <div className="dashboard-section-heading">
        <div>
          <span className="dashboard-eyebrow">SmartBook</span>
          <h2 id="smartbook-heading">繼續你的閱讀</h2>
        </div>
        <Link className="dashboard-text-link" to="/books">
          查看全部書庫 <span aria-hidden="true">→</span>
        </Link>
      </div>

      {status === "loading" ? <LoadingCards /> : null}

      {status === "error" ? (
        <div className="dashboard-state dashboard-state-error" role="alert">
          <span className="dashboard-state-icon" aria-hidden="true">!</span>
          <div>
            <strong>SmartBook 暫時無法載入</strong>
            <p>{error || "請稍後再試。"}</p>
          </div>
          <button className="dashboard-secondary-button" type="button" onClick={onRetry}>
            重試
          </button>
        </div>
      ) : null}

      {status === "success" && books.length === 0 ? (
        <div className="dashboard-state dashboard-state-empty">
          <span className="dashboard-state-icon" aria-hidden="true">＋</span>
          <div>
            <strong>還沒有可閱讀的 SmartBook</strong>
            <p>書本上架後，會在這裡顯示你的閱讀入口。</p>
          </div>
          <Link className="dashboard-secondary-button" to="/books">前往書庫</Link>
        </div>
      ) : null}

      {status === "success" && books.length > 0 ? (
        <div className="dashboard-book-grid">
          {books.slice(0, 6).map((book) => <SmartBookCard book={book} key={book.id} />)}
        </div>
      ) : null}
    </section>
  );
}
