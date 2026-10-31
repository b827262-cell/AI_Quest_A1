import type { FilesTabState } from "./useFilesTab";
import { type ReaderTocFormat } from "./file-utils";

export function ReaderTocPanel({ state }: { state: FilesTabState }) {
  const { readerToc, busy, readerTocFormat, setReaderTocFormat, readerTocContent, setReaderTocContent, readerTocPreview, readerTocPreviewError, readerTocSectionRef, readerTocPreviewText, looksLikeSentenceIndex, onPreviewReaderToc, onImportReaderToc, onDeleteReaderToc } = state;
  return (
    <>
      <div className="card" ref={readerTocSectionRef}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Manual Reader TOC</h3>
            <p className="muted" style={{ margin: 0 }}>
              Import structured chapter/section hierarchy used by the student reader.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <select
              value={readerTocFormat}
              onChange={(e) => setReaderTocFormat(e.target.value as ReaderTocFormat)}
              disabled={busy}
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
            <button className="btn secondary" onClick={() => onPreviewReaderToc()} disabled={busy}>
              Preview
            </button>
            <button className="btn" onClick={() => void onImportReaderToc()} disabled={busy || !readerTocContent.trim()}>
              Import / Replace
            </button>
            <button className="btn secondary" onClick={() => void onDeleteReaderToc()} disabled={busy || !readerToc?.file}>
              Delete TOC
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ margin: 0 }}>
            Active TOC:
          </span>
          <strong style={{ color: readerToc?.file ? undefined : "#64748b" }}>
            {readerToc?.file?.fileName ?? "none"}
          </strong>
          {readerToc?.file ? <span className="muted">Items: {readerToc.file.itemCount}</span> : null}
          {readerToc?.file ? <span className="muted">Updated: {readerToc.file.createdAt}</span> : null}
        </div>

        <textarea
          style={{ width: "100%", minHeight: 220, marginTop: 10, resize: "vertical" }}
          value={readerTocContent}
          onChange={(e) => setReaderTocContent(e.target.value)}
          placeholder="# 第零章 緒論 p.1\n- 一、國際會計準則 p.2\n- 二、我國財務會計準則 p.3\n- 三、修正商業會計法 p.4"
        />

        {looksLikeSentenceIndex ? (
          <p className="error" style={{ marginTop: 8 }}>
            This is a sentence JSON Index, not a Reader TOC. Use “Generate Reader TOC from JSON
            Index” instead.
          </p>
        ) : null}

        {readerTocPreviewError ? <p className="error">{readerTocPreviewError}</p> : null}

        {readerTocContent.trim() || readerTocPreview.length > 0 ? (
          <div className="admin-json-panel" style={{ marginTop: 12 }}>
            <details open>
              <summary>Preview parsed tree</summary>
              <pre className="files-json-preview" style={{ marginTop: 8 }}>
                {readerTocPreviewText || "(empty)"}
              </pre>
            </details>
          </div>
        ) : null}
      </div>
    </>
  );
}
