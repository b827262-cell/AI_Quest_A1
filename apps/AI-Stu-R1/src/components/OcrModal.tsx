import { useState } from "react";
import { PrimaryButton, GhostButton } from "./ui/Buttons";

interface OcrModalProps {
  onClose: () => void;
  onOcrSuccess: (text: string) => void;
}

const OCR_SAMPLES = [
  {
    name: "📐 數學公式手寫截圖.png",
    text: "求函數 f(x) = x^3 - 3x^2 + 2 在區間 [0, 3] 上的極值。"
  },
  {
    name: "💻 演算法考題截圖.png",
    text: "如何實現 BST 中序遍歷並分析時間與空間複雜度？"
  },
  {
    name: "📜 歷史申論題截圖.png",
    text: "分析 19 世紀英國工業革命對都市化與階級結構的影響。"
  }
];

export function OcrModal({ onClose, onOcrSuccess }: OcrModalProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [step, setStep] = useState<"upload" | "result">("upload");

  function handleSelectSample(sampleText: string, sampleName: string) {
    setSelectedFile(sampleName);
    setRecognizing(true);
    // Simulate OCR progress
    setTimeout(() => {
      setOcrText(sampleText);
      setRecognizing(false);
      setStep("result");
    }, 1200);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file.name);
    setRecognizing(true);
    // Simulate OCR progress
    setTimeout(() => {
      setOcrText("偵測到上傳的圖片文字：\n請設計一程式驗證 XSS 漏洞的防禦機制。");
      setRecognizing(false);
      setStep("result");
    }, 1500);
  }

  function handleConfirm() {
    if (!ocrText.trim()) return;
    onOcrSuccess(ocrText.trim());
    onClose();
  }

  return (
    <div className="gemini-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ocr-title">
      <div className="gemini-modal-card">
        <div className="modal-header">
          <h3 id="ocr-title">✨ OCR 題目截圖識別</h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="關閉">
            &times;
          </button>
        </div>

        <div className="modal-body">
          {step === "upload" && (
            <div className="ocr-upload-view">
              <p className="muted" style={{ marginBottom: 16 }}>
                請上傳包含題目或公式的截圖，系統將自動提取文字並導入智慧解題。
              </p>

              <div className="ocr-dropzone">
                <span className="dropzone-icon">📷</span>
                <label className="dropzone-label">
                  拖曳圖片至此或 <span>選擇檔案</span>
                  <input type="file" accept="image/*" onChange={handleFileUpload} style={{ display: "none" }} />
                </label>
                <span className="dropzone-sub">支援 PNG, JPG, WEBP</span>
              </div>

              {recognizing && (
                <div className="ocr-progress-area" style={{ marginTop: 16, textAlign: "center" }}>
                  <div className="ocr-spinner" />
                  <p className="active animate-pulse" style={{ marginTop: 8, fontSize: 13, color: "var(--primary)" }}>
                    正在辨識圖片文字，請稍候...
                  </p>
                </div>
              )}

              {!recognizing && (
                <div className="ocr-samples-section" style={{ marginTop: 20 }}>
                  <h4 style={{ fontSize: 13, marginBottom: 8, color: "var(--text)" }}>快速選用測試範例圖片</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {OCR_SAMPLES.map((sample) => (
                      <button
                        key={sample.name}
                        type="button"
                        className="ocr-sample-row-btn"
                        onClick={() => handleSelectSample(sample.text, sample.name)}
                      >
                        <span>📄</span>
                        <div style={{ textAlign: "left" }}>
                          <strong>{sample.name}</strong>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "result" && (
            <div className="ocr-result-view">
              <p className="muted" style={{ marginBottom: 8 }}>
                已識別到以下文字，您可以在送出前調整內容：
              </p>

              <div className="ocr-preview-file" style={{ marginBottom: 12, padding: "8px 12px", background: "var(--panel-soft)", borderRadius: 8, fontSize: 12 }}>
                🖼️ 檔案：{selectedFile}
              </div>

              <textarea
                className="ocr-result-textarea"
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
                rows={6}
                style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid var(--border)", font: "inherit" }}
              />

              <div className="modal-actions" style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <GhostButton onClick={() => setStep("upload")}>重新上傳</GhostButton>
                <PrimaryButton onClick={handleConfirm} disabled={!ocrText.trim()}>
                  送出智慧解題
                </PrimaryButton>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
