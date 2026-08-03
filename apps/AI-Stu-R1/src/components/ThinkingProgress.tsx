import type { CSSProperties } from "react";
import "./ThinkingProgress.css";
export {
  ANSWER_REVEAL_DELAY_MS,
  GUEST_EXTENDED_WAIT_AFTER_MS,
  GUEST_EXTENDED_WAIT_MS,
  GUEST_MAX_WAIT_MS
} from "../guestAnswerRequest";

export function estimateThinkingProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) return 5;
  if (elapsedMs < 10_000) return 5 + (elapsedMs / 10_000) * 15;
  if (elapsedMs < 60_000) return 20 + ((elapsedMs - 10_000) / 50_000) * 55;
  if (elapsedMs < 90_000) return 75 + ((elapsedMs - 60_000) / 30_000) * 15;
  if (elapsedMs < 150_000) return 90 + ((elapsedMs - 90_000) / 60_000) * 9;
  return 99;
}

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatProgressBar(progress: number, size = 22): string {
  const safeSize = Math.max(1, Math.floor(size));
  const bounded = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((bounded / 100) * safeSize);
  return `${"█".repeat(filled)}${"░".repeat(safeSize - filled)}`;
}

export function getThinkingStage(progress: number): string {
  if (progress >= 100) return "答案完成";
  if (progress <= 20) return "正在讀取題目";
  if (progress <= 50) return "正在分析解題方向";
  if (progress <= 80) return "正在產生完整答案";
  return "正在整理答案格式";
}

function formatElapsed(elapsedMs: number): string {
  return formatElapsedTime(elapsedMs);
}

function progressStage(progress: number): string {
  return getThinkingStage(progress);
}

function BrandBookIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="brand-book-gradient" x1="6" y1="8" x2="42" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2396F3" />
          <stop offset="1" stopColor="#6037D8" />
        </linearGradient>
      </defs>
      <path d="M5 11.5 21.2 16v24L5 34.5v-23Z" fill="url(#brand-book-gradient)" />
      <path d="M43 11.5 26.8 16v24L43 34.5v-23Z" fill="url(#brand-book-gradient)" />
      <path d="M24 7.5 28.1 16l8.4 4.1-8.4 4.1L24 32.7l-4.1-8.5-8.4-4.1 8.4-4.1L24 7.5Z" fill="white" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 52 52" aria-hidden="true">
      <path d="M26 4c2.6 10.2 7.8 15.4 18 18-10.2 2.6-15.4 7.8-18 18-2.6-10.2-7.8-15.4-18-18C18.2 19.4 23.4 14.2 26 4Z" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" />
      <circle cx="45" cy="8" r="3" fill="currentColor" opacity=".35" />
      <circle cx="6" cy="39" r="2.5" fill="currentColor" opacity=".28" />
    </svg>
  );
}

function BulbIcon() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M12 18.3a8 8 0 1 1 16 0c0 4-2 5.8-4.2 8.1-.8.8-1.2 1.6-1.3 2.6h-5c-.1-1-.5-1.8-1.3-2.6C14 24.1 12 22.3 12 18.3Z" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M17 33h6M18 36h4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

type PuzzleBrainProps = {
  progress: number;
};

function PuzzleBrain({ progress }: PuzzleBrainProps) {
  const bounded = Math.max(0, Math.min(100, progress));
  const clipY = 420 - (bounded / 100) * 420;
  const clipHeight = (bounded / 100) * 420;

  const puzzlePieces = (
    <>
      <path d="M139 54c-29 8-52 31-61 60l42 10c-2 14 8 27 22 29 15 2 28-8 30-23 1-7-1-14-5-20l41-29c-18-22-43-32-69-27Z" />
      <path d="M211 77 168 108c6 6 8 14 6 22-3 14-17 23-31 20-8-2-15-7-18-14l-49 10c-2 27 7 52 24 72l45-21c5 12 19 18 31 13 13-5 19-19 14-32-3-7-8-12-15-15l36-86Z" />
      <path d="M213 77c34 2 64 18 85 44l-24 36c8 4 14 12 14 21 0 13-11 24-24 24-8 0-15-4-20-10l-54 18c5 13-1 27-14 32-13 5-27-1-32-14-3-7-2-15 1-21l-44 21c17 21 39 34 65 39l47 9V77Z" />
      <path d="M213 77h34c41 0 78 22 98 57l18 31 33 31c7 7 5 18-4 22l-26 12v43c0 28-22 50-50 50h-43l-11 73-49-13V77Z" />
      <path d="M100 218c-22 22-35 52-35 84 0 31 12 59 32 81l70-49c-9-9-10-23-2-33 9-10 24-11 34-2 6 5 9 13 8 21l55 7 11-54-60-8c1-14-9-26-23-27-11-1-21 6-25 16l-65-36Z" />
      <path d="M167 334 97 383c18 19 42 32 69 37l50 9 11-77-20-32c1-8-2-16-8-21-10-9-25-8-34 2-8 10-7 24 2 33Z" />
      <path d="m207 320 20 32-11 77 58-8-12-38 11-56-55-7h-11Z" />
    </>
  );

  return (
    <svg className="thinking-puzzle-brain" viewBox="0 0 460 460" role="img" aria-label={`拼圖大腦預估完成度 ${Math.round(bounded)}%`}>
      <defs>
        <filter id="brain-soft-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="18" stdDeviation="18" floodColor="#5f6ac8" floodOpacity=".18" />
        </filter>
        <clipPath id="brain-progress-clip">
          <rect x="0" y={clipY} width="460" height={clipHeight} />
        </clipPath>
        <linearGradient id="brain-ghost" x1="80" y1="55" x2="360" y2="420" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f5f7ff" />
          <stop offset="1" stopColor="#dde4f4" />
        </linearGradient>
      </defs>

      <ellipse cx="231" cy="426" rx="145" ry="20" fill="#6d76cd" opacity=".09" />
      <circle cx="232" cy="225" r="185" fill="#edf2ff" opacity=".46" />

      <g className="thinking-particles" aria-hidden="true">
        <circle cx="43" cy="123" r="12" fill="#8d2caa" />
        <circle cx="82" cy="108" r="8" fill="#ef57db" />
        <circle cx="122" cy="111" r="19" fill="#ffe600" />
        <circle cx="81" cy="159" r="15" fill="#1713dc" />
        <circle cx="127" cy="165" r="9" fill="#202020" />
        <circle cx="176" cy="145" r="14" fill="#d9cf72" />
        <circle cx="72" cy="73" r="9" fill="#10dbe3" />
        <circle cx="115" cy="76" r="8" fill="#7bcbd4" />
        <circle cx="153" cy="76" r="9" fill="#9bd18d" />
        <circle cx="103" cy="199" r="16" fill="#ff0b0b" />
        <circle cx="144" cy="209" r="11" fill="#a90d16" />
        <circle cx="169" cy="187" r="12" fill="#df2f73" />
      </g>

      <g transform="translate(18 4)" filter="url(#brain-soft-shadow)">
        <g className="brain-ghost-layer" fill="url(#brain-ghost)" stroke="#ffffff" strokeWidth="5" strokeLinejoin="round">
          {puzzlePieces}
        </g>
        <g clipPath="url(#brain-progress-clip)" stroke="#ffffff" strokeWidth="5" strokeLinejoin="round">
          <path fill="#34a7df" d="M139 54c-29 8-52 31-61 60l42 10c-2 14 8 27 22 29 15 2 28-8 30-23 1-7-1-14-5-20l41-29c-18-22-43-32-69-27Z" />
          <path fill="#ec1688" d="M211 77 168 108c6 6 8 14 6 22-3 14-17 23-31 20-8-2-15-7-18-14l-49 10c-2 27 7 52 24 72l45-21c5 12 19 18 31 13 13-5 19-19 14-32-3-7-8-12-15-15l36-86Z" />
          <path fill="#f9b719" d="M213 77c34 2 64 18 85 44l-24 36c8 4 14 12 14 21 0 13-11 24-24 24-8 0-15-4-20-10l-54 18c5 13-1 27-14 32-13 5-27-1-32-14-3-7-2-15 1-21l-44 21c17 21 39 34 65 39l47 9V77Z" />
          <path fill="#58bb2f" d="M213 77h34c41 0 78 22 98 57l18 31 33 31c7 7 5 18-4 22l-26 12v43c0 28-22 50-50 50h-43l-11 73-49-13V77Z" />
          <path fill="#ef1c86" d="M100 218c-22 22-35 52-35 84 0 31 12 59 32 81l70-49c-9-9-10-23-2-33 9-10 24-11 34-2 6 5 9 13 8 21l55 7 11-54-60-8c1-14-9-26-23-27-11-1-21 6-25 16l-65-36Z" />
          <path fill="#c61059" d="M167 334 97 383c18 19 42 32 69 37l50 9 11-77-20-32c1-8-2-16-8-21-10-9-25-8-34 2-8 10-7 24 2 33Z" />
          <path fill="#19a9df" d="m207 320 20 32-11 77 58-8-12-38 11-56-55-7h-11Z" />
        </g>
      </g>
    </svg>
  );
}

export type ThinkingProgressProps = {
  progress: number;
  elapsedMs: number;
  onCancel: () => void;
};

export function ThinkingProgress({ progress, elapsedMs, onCancel }: ThinkingProgressProps) {
  const bounded = Math.max(0, Math.min(100, progress));
  const rounded = Math.round(bounded);
  const style = { "--thinking-progress": `${bounded}%` } as CSSProperties;

  return (
    <section className={`thinking-progress-card${bounded >= 100 ? " is-complete" : ""}`} aria-live="polite" aria-busy={bounded < 100}>
      <div className="thinking-card-brand">
        <span className="thinking-brand-icon"><BrandBookIcon /></span>
        <strong>AI-SmartBook</strong>
      </div>

      <div className="thinking-card-layout">
        <div className="thinking-visual-column">
          <PuzzleBrain progress={bounded} />
        </div>

        <div className="thinking-copy-column">
          <div className="thinking-title-row">
            <span className="thinking-sparkle"><SparkleIcon /></span>
            <div>
              <h2>AI 思考中</h2>
              <p>{bounded >= 100 ? "答案已完成，正在開啟…" : "正在整理答案，請稍候…"}</p>
            </div>
          </div>

          <div className="thinking-divider" />

          <div className="thinking-percentage" aria-label={`預估完成度 ${rounded}%`}>
            {rounded}<span>%</span>
          </div>

          <div className="thinking-progress-track" style={style}>
            <span className="thinking-progress-fill" />
            <span className="thinking-progress-value">{rounded}%</span>
          </div>

          <div className="thinking-tip">
            <span className="thinking-tip-icon"><BulbIcon /></span>
            <p><strong>小提醒：</strong>AI 正在深度分析內容，為你提供更精準的答案。</p>
          </div>

          <div className="thinking-status-row">
            <span>{progressStage(bounded)}</span>
            <span>已經過 {formatElapsed(elapsedMs)}</span>
            {bounded < 100 ? (
              <button type="button" onClick={onCancel}>停止解題</button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export type ExtendedWaitDialogProps = {
  open: boolean;
  progress: number;
  remainingMs: number;
  onContinue: () => void;
  onStop: () => void;
};

export function ExtendedWaitDialog({
  open,
  progress,
  remainingMs,
  onContinue,
  onStop
}: ExtendedWaitDialogProps) {
  if (!open) return null;

  const percentage = Math.max(0, Math.min(99, Math.round(progress)));
  const countdown = formatElapsed(Math.ceil(Math.max(0, remainingMs) / 1000) * 1000);

  return (
    <div className="thinking-dialog-backdrop">
      <section className="thinking-dialog" role="dialog" aria-modal="true" aria-labelledby="extended-wait-title">
        <div className="thinking-dialog-icon" aria-hidden="true">✦</div>
        <h2 id="extended-wait-title">這題需要較多處理時間</h2>
        <p>
          AI 仍在完成答案，預計還需要約 60 秒。目前的解題進度不會中斷，也不會重新送出題目。
        </p>
        <div className="thinking-dialog-stats">
          <div><span>預估完成度</span><strong>{percentage}%</strong></div>
          <div><span>剩餘等候時間</span><strong>{countdown}</strong></div>
        </div>
        <div className="thinking-dialog-progress" aria-hidden="true">
          <span style={{ width: `${percentage}%` }} />
        </div>
        <div className="thinking-dialog-actions">
          <button type="button" className="thinking-continue-button" onClick={onContinue}>繼續等候</button>
          <button type="button" className="thinking-stop-button thinking-stop-button-secondary" onClick={onStop}>停止解題</button>
        </div>
      </section>
    </div>
  );
}
