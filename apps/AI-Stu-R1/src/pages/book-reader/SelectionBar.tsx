export function SelectionBar({
  open,
  selectedText,
  copyNotice,
  pageHasText,
  onCopySelection,
  onSelectionToNote,
  onAskAiAboutSelection
}: {
  open: boolean;
  selectedText: string;
  copyNotice: string;
  pageHasText: boolean;
  onCopySelection: () => void;
  onSelectionToNote: () => void;
  onAskAiAboutSelection: () => void;
}) {
  if (!open) return null;

  return (
    <div className="pdf-select-bar">
      {selectedText ? (
        <>
          <span className="pdf-select-info">
            已選取 {selectedText.length} 字
          </span>
          <button type="button" className="tool-btn" onClick={() => onCopySelection()}>
            複製
          </button>
          <button type="button" className="tool-btn" onClick={() => onSelectionToNote()}>
            加入筆記
          </button>
          <button type="button" className="tool-btn ask" onClick={onAskAiAboutSelection}>
            問AI重點
          </button>
          {copyNotice ? <span className="pdf-select-info">{copyNotice}</span> : null}
        </>
      ) : (
        <span className="pdf-select-info muted">
          {pageHasText
            ? "拖曳選取 PDF 文字後，可複製 / 加入筆記 / 問AI重點。"
            : "此頁目前無可選取文字，可能是掃描圖像 PDF。"}
        </span>
      )}
    </div>
  );
}
