import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import type { Book } from "@ai-smartbook/schema";
import { adminApi } from "../api";
import { FilesTab } from "./tabs/FilesTab";
import { ContentsTab } from "./tabs/ContentsTab";
import { ChaptersTab } from "./tabs/ChaptersTab";
import { QaTab } from "./tabs/QaTab";
import { AiJobsTab } from "./tabs/AiJobsTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { ReadingProgressTab } from "./tabs/ReadingProgressTab";
import { StudentNotesTab } from "./tabs/StudentNotesTab";

export function BookDetail() {
  const { bookId = "" } = useParams();
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi
      .getBook(bookId)
      .then((d) => setBook(d.book))
      .catch((e) => setError(String(e.message)));
  }, [bookId]);

  if (error) return <p className="error">{error}</p>;
  if (!book) return <p className="muted">載入中…</p>;

  const base = `/admin/books/${bookId}`;
  const tab = (to: string, label: string, end = false) => (
    <NavLink to={`${base}${to}`} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
      {label}
    </NavLink>
  );

  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{book.title}</h2>
        <span className={`badge ${book.status}`}>{book.status}</span>
      </div>
      <div className="tabs">
        {tab("", "總覽", true)}
        {tab("/files", "檔案 / PDF")}
        {tab("/contents", "內容")}
        {tab("/chapters", "章節")}
        {tab("/qa", "知識問答")}
        {tab("/ai-jobs", "AI 任務")}
        {tab("/progress", "閱讀分析")}
        {tab("/notes", "學生筆記")}
      </div>
      <Routes>
        <Route index element={<OverviewTab bookId={bookId} />} />
        <Route path="files" element={<FilesTab bookId={bookId} />} />
        <Route path="contents" element={<ContentsTab bookId={bookId} />} />
        <Route path="chapters" element={<ChaptersTab bookId={bookId} />} />
        <Route path="qa" element={<QaTab bookId={bookId} />} />
        <Route path="ai-jobs" element={<AiJobsTab bookId={bookId} />} />
        <Route path="progress" element={<ReadingProgressTab bookId={bookId} />} />
        <Route path="notes" element={<StudentNotesTab bookId={bookId} />} />
      </Routes>
    </div>
  );
}
