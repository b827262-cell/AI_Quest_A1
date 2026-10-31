import type { FilesTabState } from "./useFilesTab";

export function JsonIndexes({ state }: { state: FilesTabState }) {
  const { busy, jsonIndexes, tocPageStart, setTocPageStart, tocPageEnd, setTocPageEnd, genTocResult, jsonUploadRef, onUploadJsonIndex, onSetActiveJsonIndex, onGenerateReaderTocFromIndex, onViewJsonIndex, onDownloadJsonIndex, onDeleteJsonIndex } = state;
  return (
    <>
      <div className="card">
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>JSON Index / QA Reference</h3>
            <p className="muted" style={{ margin: 0 }}>
              Stored JSON indexes persist across refreshes. The active one is used as the Knowledge QA
              structured reference; with none active, QA falls back to content-based search.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              ref={jsonUploadRef}
              type="file"
              accept="application/json,.json"
              style={{ maxWidth: 280 }}
            />
            <button className="btn secondary" onClick={() => void onUploadJsonIndex()} disabled={busy}>
              Upload JSON
            </button>
          </div>
        </div>

        <div
          className="row"
          style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="muted">Reader TOC page start:</span>
          <input
            type="number"
            min={1}
            value={tocPageStart}
            onChange={(e) => setTocPageStart(e.target.value)}
            style={{ width: 88 }}
          />
          <span className="muted">page end:</span>
          <input
            type="number"
            min={1}
            value={tocPageEnd}
            onChange={(e) => setTocPageEnd(e.target.value)}
            style={{ width: 88 }}
          />
          <span className="muted">— then click “Generate Reader TOC” on a JSON Index row below.</span>
        </div>

        {genTocResult ? (
          <p
            className={genTocResult.warnings.length ? "error" : "muted"}
            style={{ marginTop: 8 }}
          >
            Reader TOC generated: {genTocResult.file?.itemCount ?? 0} items
            {genTocResult.warnings.length ? ` — ⚠ ${genTocResult.warnings.join("; ")}` : ""}
          </p>
        ) : null}

        {jsonIndexes.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No stored JSON index yet. Generate an index above and click “Save as QA Reference”, or
            upload a JSON index file.
          </p>
        ) : (
          <div className="admin-table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>File name</th>
                  <th>Level / Label</th>
                  <th>Items</th>
                  <th>Created</th>
                  <th>QA Reference</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jsonIndexes.map((idx) => (
                  <tr key={idx.fileId}>
                    <td>
                      <div>{idx.fileName}</div>
                      {!idx.valid ? (
                        <span className="badge failed">invalid / unreadable</span>
                      ) : null}
                    </td>
                    <td>
                      {idx.level ?? "—"}
                      {idx.levelLabel ? ` / ${idx.levelLabel}` : ""}
                    </td>
                    <td>{idx.itemCount ?? "—"}</td>
                    <td className="muted">{new Date(idx.createdAt).toLocaleString("zh-Hant")}</td>
                    <td>
                      {idx.isActive ? (
                        <span className="badge parsed">Active QA Reference</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        <button
                          className="btn secondary"
                          onClick={() => void onSetActiveJsonIndex(idx.fileId)}
                          disabled={busy || idx.isActive || !idx.valid}
                        >
                          Set as QA Reference
                        </button>
                        <button
                          className="btn"
                          onClick={() => void onGenerateReaderTocFromIndex(idx.fileId)}
                          disabled={busy || !idx.valid}
                          title="Generate a chapter/section Reader TOC from this index using the page range above"
                        >
                          Generate Reader TOC
                        </button>
                        <button className="btn secondary" onClick={() => onViewJsonIndex(idx.fileId)}>
                          View JSON
                        </button>
                        <button
                          className="btn secondary"
                          onClick={() => onDownloadJsonIndex(idx.fileId, idx.fileName)}
                        >
                          Download JSON
                        </button>
                        <button
                          className="btn secondary"
                          onClick={() => void onDeleteJsonIndex(idx.fileId, idx.fileName)}
                          disabled={busy}
                        >
                          Delete JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
