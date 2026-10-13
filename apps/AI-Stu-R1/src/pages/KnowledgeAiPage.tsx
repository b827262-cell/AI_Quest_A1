import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  searchPublicExamCourses,
  PUBLIC_SEARCH_MODE_OPTIONS,
  type PublicCourseSearchResult,
  type PublicExamYear,
  type PublicSourceSearchMode
} from "../knowledgeSearchContract";
import { buildKnowledgePriorities } from "../knowledgeAiDiagnostic";

const YEARS: Array<{ value: PublicExamYear | "all"; label: string }> = [
  { value: "all", label: "115、116 全部" },
  { value: "115", label: "115 年" },
  { value: "116", label: "116 年" }
];

const SEARCH_MODE_LABELS: Record<PublicSourceSearchMode, string> = {
  product_name: "品名",
  product_code: "品號",
  teacher: "師資",
  scope: "適用範圍"
};

const SEARCH_PLACEHOLDERS: Record<PublicSourceSearchMode, string> = {
  product_name: "例如：憲法、行政法概要、基本權",
  product_code: "例如：GA-CON-002、IPKKW126262",
  teacher: "例如：宗台大、林清、趙治勳",
  scope: "例如：高普考、法研所、普考"
};

export function KnowledgeAiPage() {
  const [query, setQuery] = useState("");
  const [examYear, setExamYear] = useState<PublicExamYear | "all">("all");
  const [searchMode, setSearchMode] = useState<PublicSourceSearchMode>("product_name");
  const [results, setResults] = useState<PublicCourseSearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy(true);
    setSearchError(null);
    try {
      setResults(await searchPublicExamCourses({ examYear, query, searchMode }));
      setHasSearched(true);
    } catch (error) {
      setResults([]);
      setHasSearched(true);
      setSearchError(error instanceof Error ? error.message : "公開課程搜尋暫時無法使用");
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
          <p>查找 115、116 年高普考公開課程資料。提供品名、品號、師資、適用範圍 4 種公開查詢方式，精確落到官方課程來源。</p>
          <form className="knowledge-search-form" onSubmit={(event) => void search(event)}>
            <label className="knowledge-year-label">
              <span className="sr-only">考試年度</span>
              <select
                aria-label="考試年度"
                value={examYear}
                onChange={(event) => setExamYear(event.target.value as PublicExamYear | "all")}
              >
                {YEARS.map((year) => <option key={year.value} value={year.value}>{year.label}</option>)}
              </select>
            </label>
            <label className="knowledge-mode-label">
              <span className="sr-only">公開來源查詢方式</span>
              <select
                aria-label="公開來源查詢方式"
                value={searchMode}
                onChange={(event) => setSearchMode(event.target.value as PublicSourceSearchMode)}
              >
                {PUBLIC_SEARCH_MODE_OPTIONS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
            </label>
            <label className="knowledge-search-input">
              <span className="sr-only">搜尋關鍵字</span>
              <input
                aria-label="搜尋關鍵字"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={SEARCH_PLACEHOLDERS[searchMode]}
              />
            </label>
            <button type="submit" disabled={busy}>{busy ? "搜尋中…" : "搜尋課程"}</button>
          </form>
          <p className="knowledge-contract-note">公開來源僅限 ec.ibrain.com.tw 官方網址；優先提供課程專頁或穩定搜尋 deep-link。</p>
        </section>
        {hasSearched ? (
          <section className="knowledge-results" aria-live="polite" aria-label="課程搜尋結果">
            <div className="knowledge-results-heading">
              <h2>搜尋結果</h2>
              <span>{results.length} 筆 · 查詢方式：{SEARCH_MODE_LABELS[searchMode]}</span>
            </div>
            {searchError ? <p className="knowledge-empty" role="alert">{searchError}</p> : results.length ? <ul>{buildKnowledgePriorities(results).map((priority) => {
              const course = priority.course;
              return <li key={`${course.exam_year}-${course.course_code}`}>
                <div className="knowledge-card-meta">
                  <span className="knowledge-year">{course.exam_year} 年</span>
                  <code>{course.course_code}</code>
                  <span className="knowledge-badge-mode">模式：{SEARCH_MODE_LABELS[course.source_search_mode ?? searchMode]}</span>
                  <span className="knowledge-badge-match">符合：{course.matched_field ?? "相符"}</span>
                </div>
                <h3>{course.course_name}</h3>
                {course.teacher ? <p className="knowledge-meta-line"><strong>師資：</strong>{course.teacher}</p> : null}
                {course.applicable_scope ? <p className="knowledge-meta-line"><strong>適用範圍：</strong>{course.applicable_scope}</p> : null}
                <p className="knowledge-content-text">{course.course_content}</p>
                <div className={`knowledge-diagnostic knowledge-diagnostic-${priority.evidenceStatus}`}>
                  <strong>{priority.level === "subject" ? "科目層級建議" : "類科層級建議／資料不足"}</strong>
                  <p>{priority.recommendation}</p>
                  {priority.subjects.length ? <p className="knowledge-diagnostic-evidence">依據：{priority.subjects.map((subject) => `${subject.subject}（${subject.sourceField === "course_name" ? "課名" : "課程內容"}）`).join("、")}</p> : null}
                </div>
                <div className="knowledge-source-block">
                  <span className="knowledge-source-title">來源：ibrain 知識達購課館</span>
                  {course.source_url ? <>
                    <a href={course.source_url} target="_blank" rel="noreferrer" className="knowledge-source-link">查看公開來源 ↗</a>
                    <span className="knowledge-source-url" title={course.source_url}>{course.source_url}</span>
                  </> : <span className="knowledge-source-url">公開來源暫時無法提供</span>}
                </div>
              </li>;
            })}</ul> : <p className="knowledge-empty">找不到相符的公開課程。請調整年度或關鍵字後再試。</p>}
          </section>
        ) : null}
      </main>
    </div>
  );
}
