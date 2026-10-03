import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  searchPublicExamCourses,
  type PublicCourseSearchResult,
  type PublicExamYear
} from "../knowledgeSearchContract";

const YEARS: Array<{ value: PublicExamYear | "all"; label: string }> = [
  { value: "all", label: "115、116 全部" },
  { value: "115", label: "115 年" },
  { value: "116", label: "116 年" }
];

export function KnowledgeAiPage() {
  const [query, setQuery] = useState("");
  const [examYear, setExamYear] = useState<PublicExamYear | "all">("all");
  const [results, setResults] = useState<PublicCourseSearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    try {
      setResults(await searchPublicExamCourses({ examYear, query }));
      setHasSearched(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="public-home-page knowledge-ai-page">
      <header className="public-home-header">
        <Link to="/" className="public-brand-link" aria-label="AI-SmartBook 首頁">
          <span className="public-brand-mark" aria-hidden="true">知</span><span>AI-SmartBook</span>
        </Link>
        <Link className="knowledge-back-link" to="/">返回首頁</Link>
      </header>
      <main className="public-home-main">
        <section className="knowledge-hero" aria-labelledby="knowledge-ai-heading">
          <span className="public-eyebrow">公開學習資源 · 無需登入</span>
          <h1 id="knowledge-ai-heading">知識達 AI 學習問答</h1>
          <p>查找 115、116 年高普考公開課程資料。可用課程代碼精確查詢，或以課名、內容關鍵字搜尋。</p>
          <form className="knowledge-search-form" onSubmit={(event) => void search(event)}>
            <label>
              <span className="sr-only">考試年度</span>
              <select value={examYear} onChange={(event) => setExamYear(event.target.value as PublicExamYear | "all")}>
                {YEARS.map((year) => <option key={year.value} value={year.value}>{year.label}</option>)}
              </select>
            </label>
            <label className="knowledge-search-input">
              <span className="sr-only">搜尋課程</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：GA-ADM-001、行政法、基本權" />
            </label>
            <button type="submit" disabled={busy}>{busy ? "搜尋中…" : "搜尋課程"}</button>
          </form>
          <p className="knowledge-contract-note">目前為公開 mock 資料 contract；正式資料將依 source whitelist 搜尋。</p>
        </section>
        {hasSearched ? (
          <section className="knowledge-results" aria-live="polite" aria-label="課程搜尋結果">
            <div className="knowledge-results-heading"><h2>搜尋結果</h2><span>{results.length} 筆</span></div>
            {results.length ? <ul>{results.map((course) => (
              <li key={`${course.exam_year}-${course.course_code}`}>
                <div><span className="knowledge-year">{course.exam_year} 年</span><code>{course.course_code}</code></div>
                <h3>{course.course_name}</h3><p>{course.course_content}</p>
                <a href={course.source_url} target="_blank" rel="noreferrer">查看公開來源 ↗</a>
              </li>
            ))}</ul> : <p className="knowledge-empty">找不到相符的公開課程。請調整年度或關鍵字後再試。</p>}
          </section>
        ) : null}
      </main>
    </div>
  );
}
