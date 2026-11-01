import type { FilesTabState } from "./useFilesTab";

export function GeneratedIndex({ state }: { state: FilesTabState }) {
  const { busy, generatedIndex, jsonResultRef, generatedJsonText, onDownloadJsonResult, onSaveAsQaReference } = state;
  return (
    <>
      {generatedIndex ? (
        <div className="card" ref={jsonResultRef}>
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div>
              <h3 style={{ marginTop: 0, marginBottom: 6 }}>JSON Index Result</h3>
              <p className="muted" style={{ margin: 0 }}>
                File: <strong>{generatedIndex.fileName}</strong> · Level:{" "}
                <strong>
                  {generatedIndex.level} / {generatedIndex.levelLabel}
                </strong>{" "}
                · Pages: <strong>{generatedIndex.pageCount}</strong> · Items:{" "}
                <strong>{generatedIndex.itemCount}</strong>
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => void onSaveAsQaReference()} disabled={busy}>
                Save as QA Reference
              </button>
              <button
                className="btn secondary"
                onClick={() => onDownloadJsonResult(generatedIndex.fileId)}
                disabled={busy}
              >
                Download JSON
              </button>
            </div>
          </div>

          {generatedIndex.notes?.length ? (
            <div style={{ marginTop: 12 }}>
              {generatedIndex.notes.map((note) => (
                <p key={note} className="muted" style={{ margin: "4px 0" }}>
                  {note}
                </p>
              ))}
            </div>
          ) : null}

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>View JSON</summary>
            <pre className="files-json-preview">{generatedJsonText}</pre>
          </details>
        </div>
      ) : null}
    </>
  );
}
