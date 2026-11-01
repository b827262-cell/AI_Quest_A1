import { Link } from "react-router-dom";
import { HomeAIComposer } from "../../components/HomeAIComposer";
import type { PublicSiteConfig } from "../../studentClient";
import { GuestAnswer } from "./GuestAnswer";
import { LearningHistoryPanel } from "./LearningHistoryPanel";
import { QUICK_STARTS } from "./constants";
import type { useGuestQuestion } from "./useGuestQuestion";
import type { useLearningHistorySync } from "./useLearningHistorySync";
import type { useShareIntake } from "./useShareIntake";

export function PublicHero({
  config,
  history,
  intake,
  guest
}: {
  config: PublicSiteConfig;
  history: ReturnType<typeof useLearningHistorySync>;
  intake: ReturnType<typeof useShareIntake>;
  guest: ReturnType<typeof useGuestQuestion>;
}) {
  return (
    <section className="public-hero" aria-labelledby="public-home-heading">
      <div className="public-hero-orbit public-hero-orbit-one" />
      <div className="public-hero-orbit public-hero-orbit-two" />
      <span className="public-eyebrow">智慧學習入口 · iBrain AI</span>
      <h1 id="public-home-heading">
        {history.studentName ? `${history.studentName}，${config.homeGreeting}` : config.homeGreeting}
      </h1>
      <p className="public-hero-subtitle">{config.siteSubtitle}</p>
      <p className="public-hero-copy">輸入題目、選取教材內容，或上傳圖片開始智慧解題。</p>
      <Link className="knowledge-ai-cta" to="/knowledge-ai">探索知識達 AI 學習問答 <span aria-hidden="true">→</span></Link>

    {!guest.response && !guest.restoringAnswer ? (
        <>
          <HomeAIComposer
            value={guest.question}
            onChange={guest.setQuestion}
            onSubmit={(nextSourceType) => {
              if (guest.strategy === "google-ai") guest.submitGoogleAiQuestion(nextSourceType);
              else void guest.submitGuestQuestion(nextSourceType);
            }}
            placeholder={config.homeInputPlaceholder}
            category={guest.category}
            onCategoryChange={guest.setCategory}
            strategy={guest.strategy}
            onStrategyChange={guest.setStrategy}
            providerPreference={guest.providerPreference}
            onProviderPreferenceChange={guest.setProviderPreference}
            busy={guest.busy}
            autoFocus={!guest.busy}
          />
          <div className="public-composer-meta">
            <span>{guest.strategy === "google-ai" ? "搜尋好朋友／谷哥不需 API 金鑰 · 每題最多 2,000 字" : `訪客每日可體驗 ${config.guestDailyLimit} 題 · 每題最多 2,000 字`}</span>
            <span>目前模式：{guest.category === "auto" ? "自動判斷" : guest.category}</span>
          </div>
          {guest.error ? <p className="public-form-error" role="alert">{guest.error}</p> : null}
          {intake.googleStatus ? <p className="public-google-status" role="status" aria-live="polite">{intake.googleStatus}</p> : null}
          {guest.feedback ? <p className="public-feedback-text" role="status">{guest.feedback}</p> : null}
          {guest.busy ? (
            <button type="button" className="public-back-button public-cancel-question-button" onClick={guest.resetQuestion}>
              ← 取消並返回首頁
            </button>
          ) : null}
          <div className="public-quick-starts" aria-label="快速題型">
            {QUICK_STARTS.map((item) => (
              <button
                type="button"
                key={item.label}
                onClick={() => {
                  guest.setQuestion(item.question);
                  guest.setCategory(item.category);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          {history.authStatus === "authenticated" ? <div className="learning-history-sync" role="status">
            <p>{history.syncStatus}</p>
            {history.guestImportCount > 0 ? <button type="button" onClick={history.importGuestHistory}>匯入這台裝置的 {history.guestImportCount} 筆訪客紀錄</button> : null}
            {history.syncStatus.includes("失敗") ? <button type="button" onClick={history.retrySync}>重試同步</button> : null}
          </div> : null}
          <LearningHistoryPanel
            entries={history.learningHistory}
            onEntriesChange={history.setLearningHistory}
            onStatusChange={(id, message) => intake.setHistoryStatuses((current) => ({ ...current, [id]: message }))}
            statuses={intake.historyStatuses}
            onIntake={intake.acceptIncomingAnswer}
            signedIn={history.authStatus === "authenticated"}
          />
          {intake.pendingIntake ? <section className="share-binding-choice" aria-labelledby="share-binding-heading" role="alert" aria-live="assertive">
            <h2 id="share-binding-heading" ref={intake.pendingIntakeHeadingRef} tabIndex={-1}>這份回覆要對應哪一題？</h2>
            <p>為避免放錯題目，請選擇一題（最多顯示 3 筆）。</p>
            {intake.pendingIntake.candidates.map((entry) => <button key={entry.id} type="button" onClick={() => intake.confirmPendingIntake(entry)}>{entry.question}</button>)}
            <button type="button" className="share-binding-cancel" onClick={intake.dismissPendingIntake}>先不儲存</button>
          </section> : null}
        </>
    ) : guest.restoringAnswer ? (
      <p className="public-answer-loading" role="status">正在載入回答…</p>
    ) : guest.response ? (
        <GuestAnswer
          question={guest.question}
          response={guest.response}
          onFeedback={(helpful) => void guest.submitFeedback(helpful)}
          onReset={guest.resetQuestion}
          onRetry={guest.retryGuestQuestion}
        />
      ) : null}
    </section>
  );
}
