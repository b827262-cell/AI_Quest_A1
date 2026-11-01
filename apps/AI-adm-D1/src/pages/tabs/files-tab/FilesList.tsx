import type { FilesTabState } from "./useFilesTab";
import { JSON_INDEX_LEVEL_OPTIONS, getFileRowKind } from "./file-utils";
import type { PdfJsonIndexLevel } from "@ai-smartbook/schema";

export function FilesList({ state }: { state: FilesTabState }) {
  const { files, busy, jsonLevels, setJsonLevels, generatedIndex, documentFiles, onParseContent, onParseOutline, onGenerateJsonIndex, onDelete, onViewJsonResult, onViewImageFile, onDownloadJsonResult } = state;
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Files</h3>
        {documentFiles.length === 0 ? (
          <p className="muted">No files uploaded yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Related PDF</th>
                  <th>Size</th>
                  <th>Parse status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {documentFiles.map((file) => {
                  const rowKind = getFileRowKind(file);
                  const relatedPdf =
                    file.relatedFileId != null
                      ? files.find((candidate) => candidate.id === file.relatedFileId) ?? null
                      : null;
                  const isPdfRow = rowKind === "pdf_source";
                  const isReferenceImageRow = rowKind === "reference_image";
                  const isMisclassifiedImageRow = rowKind === "misclassified_image";
                  const contentActionLabel = file.parseStatus === "parsed" ? "Re-parse Content" : "Parse Content";
                  const outlineActionLabel = file.parseStatus === "parsed" ? "Re-parse Outline" : "Parse Outline";
                  const selectedJsonLevel = jsonLevels[file.id] ?? "page";
                  const hasGeneratedJson = generatedIndex?.fileId === file.id;

                  return (
                    <tr key={file.id}>
                      <td>
                        <div>{file.fileName}</div>
                        {isMisclassifiedImageRow ? (
                          <div className="error" style={{ marginTop: 6 }}>
                            Image file is not a valid PDF parsing source on this page.
                          </div>
                        ) : null}
                        {isReferenceImageRow ? (
                          <div className="muted" style={{ marginTop: 6 }}>
                            Legacy reference image row. Upload is removed from this page.
                          </div>
                        ) : null}
                        {rowKind === "unsupported_source" ? (
                          <div className="error" style={{ marginTop: 6 }}>
                            Unsupported source file type. Only PDF source files are parseable here.
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {isPdfRow
                          ? "PDF source"
                          : isReferenceImageRow
                            ? "Reference image"
                            : isMisclassifiedImageRow
                              ? "Misclassified image"
                              : "Unsupported source"}
                      </td>
                      <td>{relatedPdf?.fileName ?? "—"}</td>
                      <td>{(file.fileSize / 1024).toFixed(1)} KB</td>
                      <td>
                        {isPdfRow ? (
                          <span className={`badge ${file.parseStatus}`}>{file.parseStatus}</span>
                        ) : (
                          <span className="muted">N/A</span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          {isPdfRow ? (
                            <>
                              <button
                                className="btn secondary"
                                onClick={() => void onParseContent(file.id)}
                                disabled={busy}
                              >
                                {contentActionLabel}
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => void onParseOutline(file.id)}
                                disabled={busy}
                              >
                                {outlineActionLabel}
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => void onGenerateJsonIndex(file.id)}
                                disabled={busy}
                              >
                                Generate JSON Index
                              </button>
                              <select
                                value={selectedJsonLevel}
                                onChange={(e) =>
                                  setJsonLevels((current) => ({
                                    ...current,
                                    [file.id]: e.target.value as PdfJsonIndexLevel
                                  }))
                                }
                                disabled={busy}
                                style={{ width: 180 }}
                              >
                                {JSON_INDEX_LEVEL_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="btn secondary"
                                onClick={() => onViewJsonResult(file.id)}
                                disabled={busy || !hasGeneratedJson}
                              >
                                View JSON
                              </button>
                              <button
                                className="btn secondary"
                                onClick={() => onDownloadJsonResult(file.id)}
                                disabled={busy || !hasGeneratedJson}
                              >
                                Download JSON
                              </button>
                            </>
                          ) : null}
                          {isReferenceImageRow ? (
                            <button
                              className="btn secondary"
                              onClick={() => onViewImageFile(file.id)}
                              disabled={busy}
                            >
                              View
                            </button>
                          ) : null}
                          {isMisclassifiedImageRow ? (
                            <button
                              className="btn secondary"
                              onClick={() => onViewImageFile(file.id)}
                              disabled={busy}
                            >
                              View
                            </button>
                          ) : null}
                          <button
                            className="btn secondary"
                            onClick={() => void onDelete(file.id, file.fileName)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
