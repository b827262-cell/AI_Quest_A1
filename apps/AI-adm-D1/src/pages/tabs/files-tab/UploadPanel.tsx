import type { FilesTabState } from "./useFilesTab";

export function UploadPanel({ state }: { state: FilesTabState }) {
  const { busy, msg, error, inputRef, onUploadPdf } = state;
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Upload PDF</h3>
        <div className="row">
          <input ref={inputRef} type="file" accept="application/pdf" style={{ maxWidth: 360 }} />
          <button className="btn" onClick={() => void onUploadPdf()} disabled={busy}>
            Upload
          </button>
        </div>
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}
