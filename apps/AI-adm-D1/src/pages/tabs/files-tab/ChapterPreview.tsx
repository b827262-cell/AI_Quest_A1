import type { ChapterPreviewEntryType } from "@ai-smartbook/schema";
import type { FilesTabState } from "./useFilesTab";
import { ENTRY_TYPE_OPTIONS, parseNullableInt, statusText } from "./file-utils";

export function ChapterPreview({ state }: { state: FilesTabState }) {
  const { busy, previewRows, previewFileId, previewPageCount, previewSectionRef, previewFile, updateRow, onAddRow, onRemoveRow, onApplyChapters } = state;
  return (
    <>
      {previewFileId ? (
        <div className="card" ref={previewSectionRef}>
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div>
              <h3 style={{ marginTop: 0, marginBottom: 6 }}>Preview Chapters</h3>
              <p className="muted" style={{ margin: 0 }}>
                File: <strong>{previewFile?.fileName ?? previewFileId}</strong> · Physical PDF pages:{" "}
                <strong>{previewPageCount}</strong> · Preview rows: <strong>{previewRows.length}</strong>
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn secondary" onClick={onAddRow} disabled={busy}>
                Add Row
              </button>
              <button className="btn" onClick={() => void onApplyChapters()} disabled={busy}>
                Apply Chapters
              </button>
            </div>
          </div>

          <p className="muted" style={{ marginTop: 12 }}>
            Physical PDF page numbers remain the canonical `pageStart` and `pageEnd`. Printed labels
            are display metadata only.
          </p>

          <div className="files-preview-table">
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Enabled</th>
                    <th>Original PDF Outline Title</th>
                    <th>Suggested Chapter Title</th>
                    <th>Printed Label / Range</th>
                    <th>PDF Start</th>
                    <th>PDF End</th>
                    <th>Entry Type</th>
                    <th>Sort</th>
                    <th>Admin Note</th>
                    <th>Apply Status</th>
                    <th>Row</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, index) => (
                    <tr key={row.id ?? `${row.originalTitle}-${index}`}>
                      <td>
                        <input
                          type="checkbox"
                          style={{ width: "auto" }}
                          checked={row.enabled}
                          onChange={(e) => updateRow(index, { ...row, enabled: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div style={{ paddingLeft: `${Math.min(row.outlineLevel, 4) * 12}px` }}>
                          {row.originalTitle || <span className="muted">Manual row</span>}
                        </div>
                      </td>
                      <td>
                        <input
                          value={row.suggestedTitle}
                          onChange={(e) =>
                            updateRow(index, { ...row, suggestedTitle: e.target.value })
                          }
                          placeholder="Chapter title"
                        />
                      </td>
                      <td>
                        <input
                          value={row.printedPageLabel ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, printedPageLabel: e.target.value || null })
                          }
                          placeholder="Printed page label"
                        />
                      </td>
                      <td>
                        <input
                          value={row.pageStart ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, pageStart: parseNullableInt(e.target.value) })
                          }
                          placeholder="10"
                        />
                      </td>
                      <td>
                        <input
                          value={row.pageEnd ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, pageEnd: parseNullableInt(e.target.value) })
                          }
                          placeholder="47"
                        />
                      </td>
                      <td>
                        <select
                          value={row.entryType}
                          onChange={(e) =>
                            updateRow(index, {
                              ...row,
                              entryType: e.target.value as ChapterPreviewEntryType
                            })
                          }
                        >
                          {ENTRY_TYPE_OPTIONS.map((entryType) => (
                            <option key={entryType} value={entryType}>
                              {entryType}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          value={row.sortOrder}
                          onChange={(e) =>
                            updateRow(index, {
                              ...row,
                              sortOrder: parseNullableInt(e.target.value) ?? row.sortOrder
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={row.adminNote ?? ""}
                          onChange={(e) =>
                            updateRow(index, { ...row, adminNote: e.target.value || null })
                          }
                          placeholder="Optional note"
                        />
                      </td>
                      <td>
                        <span className={`badge ${row.applyStatus === "ready" ? "parsed" : "draft"}`}>
                          {statusText(row.applyStatus)}
                        </span>
                      </td>
                      <td>
                        <button
                          className="admin-link-btn"
                          onClick={() => onRemoveRow(index)}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
