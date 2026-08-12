import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Navigate } from "react-router-dom";
import { studentClient } from "../studentClient";
import { useAppearance } from "../appearance";
import {
  groupBooksByCategory,
  matchesBookSearch,
  sortBooksNewestFirst,
  type StudentBook
} from "../bookDisplay";
import { HeroSearchSection } from "../components/HeroSearchSection";
import { BookShelfSection } from "../components/BookShelfSection";

export function BooksPage() {
  const a = useAppearance();
  const [books, setBooks] = useState<StudentBook[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [query, setQuery] = useState("");

  // Build the page background from the admin appearance settings. A broken
  // image URL simply reveals the white base colour (no white-screen).
  function buildPageBackground(): string {
    if (a.studentPageBackgroundMode === "solid") {
      return a.studentPageBackgroundColor || "#ffffff";
    }
    if (a.studentPageBackgroundMode === "gradient") {
      return `linear-gradient(180deg, ${a.studentPageBackgroundGradientFrom}, ${a.studentPageBackgroundGradientTo})`;
    }
    // image
    if (!a.studentPageBackgroundImageUrl) return "#ffffff";
    const size = a.studentPageBackgroundImageFit;
    return `#ffffff url("${a.studentPageBackgroundImageUrl}") ${a.studentPageBackgroundImagePosition} / ${size} ${a.studentPageBackgroundImageRepeat}`;
  }

  // Apply the homepage background to <body> only while on this page.
  useEffect(() => {
    const bg = buildPageBackground();
    document.documentElement.style.setProperty("--student-page-background", bg);
    return () => {
      document.documentElement.style.removeProperty("--student-page-background");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    a.studentPageBackgroundMode,
    a.studentPageBackgroundColor,
    a.studentPageBackgroundGradientFrom,
    a.studentPageBackgroundGradientTo,
    a.studentPageBackgroundImageUrl,
    a.studentPageBackgroundImageFit,
    a.studentPageBackgroundImagePosition,
    a.studentPageBackgroundImageRepeat
  ]);

  // Expose the layout settings as CSS variables consumed by the homepage CSS.
  const layoutVars = {
    "--stu-content-max": `${a.studentContentMaxWidth}px`,
    "--stu-cat-gap": `${a.studentCategoryGap}px`,
    "--stu-cat-title": `${a.studentCategoryTitleFontSize}px`,
    "--stu-card-w": `${a.studentBookCardWidth}px`,
    "--stu-cover-h": `${a.studentBookCoverHeight}px`,
    "--stu-grid-gap": `${a.studentBookGridGap}px`,
    "--stu-card-radius": `${a.studentBookCardRadius}px`,
    "--stu-cover-fit": a.studentBookCoverFit
  } as CSSProperties;

  useEffect(() => {
    let active = true;
    studentClient
      .getPublicSiteConfig()
      .then((config) => {
        if (!active) return;
        if (!config.booksPageEnabled) {
          setDisabled(true);
          setLoading(false);
          return;
        }
        return studentClient
          .listBooks()
          .then((d) => active && setBooks(d.books as StudentBook[]))
          .catch((e) => active && setError(String(e.message)))
          .finally(() => active && setLoading(false));
      })
      .catch((e) => {
        if (!active) return;
        setError(String(e.message));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredBooks = useMemo(
    () => books.filter((book) => matchesBookSearch(book, query)),
    [books, query]
  );
  const groups = useMemo(() => groupBooksByCategory(filteredBooks), [filteredBooks]);
  const latestBooks = useMemo(
    () => sortBooksNewestFirst(filteredBooks).slice(0, 8),
    [filteredBooks]
  );

  if (disabled) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="books-homepage" style={layoutVars}>
      <HeroSearchSection query={query} onQueryChange={setQuery} />

      <section className="books-homepage-state">
        <div className="bookshelf-inner">
          {error ? <p className="error-text">{error}</p> : null}
          {loading ? <p className="muted">載入中…</p> : null}
          {!loading && !error && books.length === 0 ? (
            <p className="muted">目前沒有可閱讀的書本。</p>
          ) : null}
          {!loading && !error && books.length > 0 && filteredBooks.length === 0 ? (
            <p className="muted">找不到符合搜尋條件的書籍。</p>
          ) : null}
        </div>
      </section>

      {!loading && !error && filteredBooks.length > 0 ? (
        <BookShelfSection groups={groups} latestBooks={latestBooks} />
      ) : null}
    </div>
  );
}
