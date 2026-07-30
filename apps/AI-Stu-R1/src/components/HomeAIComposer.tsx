import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GuestQuestionCategory, GuestProviderPreference } from "../studentClient";

export interface HomeAIComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (sourceType: "manual" | "image" | "file") => void;
  placeholder: string;
  category: GuestQuestionCategory;
  onCategoryChange: (category: GuestQuestionCategory) => void;
  providerPreference: GuestProviderPreference;
  onProviderPreferenceChange: (provider: GuestProviderPreference) => void;
  disabled?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
}

const CATEGORY_OPTIONS: Array<{ value: GuestQuestionCategory; label: string }> = [
  { value: "auto", label: "自動判斷" },
  { value: "programming", label: "程式設計" },
  { value: "math", label: "數學解題" },
  { value: "humanities", label: "文科問答" },
  { value: "cybersecurity", label: "資通安全" },
  { value: "教材問答", label: "教材問答" }
];

export function HomeAIComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  category,
  onCategoryChange,
  providerPreference,
  onProviderPreferenceChange,
  disabled = false,
  busy = false,
  autoFocus = false
}: HomeAIComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const [sourceType, setSourceType] = useState<"manual" | "image" | "file">("manual");
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => questionInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(sourceType);
  }

  function selectFile(file: File | undefined) {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    setSourceType(isImage ? "image" : "file");
    setFileName(file.name);
  }

  return (
    <form className="home-ai-composer" onSubmit={handleSubmit}>
      <div className="home-ai-composer-tools">
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/*,.pdf,.txt,.md"
          onChange={(event) => selectFile(event.target.files?.[0])}
        />
        <button
          type="button"
          className="composer-icon-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || busy}
          aria-label="上傳圖片或文件"
          title="上傳圖片或文件"
        >
          ＋
        </button>
      </div>

      <div className="home-ai-composer-main">
        <textarea
          ref={questionInputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={2000}
          rows={2}
          disabled={disabled || busy}
          autoFocus={autoFocus}
          aria-label="訪客問題"
        />
        {fileName ? <span className="composer-file-chip">{fileName}</span> : null}
      </div>

      <div className="home-ai-composer-actions">
        <label className="composer-mode-select">
          <span className="sr-only">AI 模型</span>
          <select value={providerPreference} onChange={(event) => onProviderPreferenceChange(event.target.value as GuestProviderPreference)} disabled={disabled || busy} aria-label="AI 模型">
            <option value="auto">Auto</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="kimi">Kimi</option><option value="qwen">Qwen</option>
          </select>
        </label>
        <label className="composer-mode-select">
          <span className="sr-only">解題模式</span>
          <select
            value={category}
            onChange={(event) => onCategoryChange(event.target.value as GuestQuestionCategory)}
            disabled={disabled || busy}
            aria-label="解題模式"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="composer-icon-button composer-mic-button"
          disabled={disabled || busy}
          aria-label="語音輸入（目前示範版）"
          title="語音輸入（目前示範版）"
        >
          ◌
        </button>
        <button
          type="submit"
          className="composer-submit-button"
          disabled={disabled || busy || !value.trim()}
          aria-label="送出問題"
        >
          {busy ? "…" : "➤"}
        </button>
      </div>
    </form>
  );
}
