import Link from "next/link";

type SignInPageProps = {
  searchParams: Promise<{
    cancelled?: string | string[];
    error?: string | string[];
    return_to?: string | string[];
  }>;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInWithChatGPTPage({
  searchParams,
}: SignInPageProps) {
  const query = await searchParams;
  const error = firstQueryValue(query.error);
  const cancelled = firstQueryValue(query.cancelled) === "1";
  const notice = error
    ? "登入暫時沒有完成，請稍後再試一次。"
    : cancelled
      ? "你已取消登入；準備好時，隨時可以繼續。"
      : null;

  return (
    <main className="signin-page">
      <div className="signin-orbit signin-orbit-one" aria-hidden="true" />
      <div className="signin-orbit signin-orbit-two" aria-hidden="true" />
      <header className="signin-nav">
        <Link className="signin-brand" href="/" aria-label="AI-SmartBook 首頁">
          <span aria-hidden="true">✦</span>
          <strong>AI-SmartBook</strong>
        </Link>
        <Link className="signin-home-link" href="/">返回首頁</Link>
      </header>

      <section className="signin-card" aria-labelledby="signin-title">
        <p className="signin-eyebrow"><span />開始你的學習工作台</p>
        <h1 id="signin-title">用 ChatGPT<br /><em>接續學習。</em></h1>
        <p className="signin-lead">登入後，你的閱讀、提問與學習節奏會留在同一個清楚的位置。</p>

        {notice && <p className="signin-notice" role="alert">{notice}</p>}

        <span className="signin-continue" aria-disabled="true" data-cta-function="AUTH_BLOCKED">
          使用 ChatGPT 繼續 <span aria-hidden="true">→</span>
        </span>
        <p className="signin-notice">目前尚未設定可用的 ChatGPT 登入交接；此按鈕暫時無法開始登入。</p>
        <Link className="signin-cancel" href="/">暫時不要，返回首頁</Link>

        <div className="signin-focus" aria-label="本頁學習重點">
          <p>本頁學習重點</p>
          <ul>
            <li><span aria-hidden="true">01</span><div><b>AI 輔助理解題目與觀念</b><small>用 AI 幫助釐清題意與概念，但保留自己的理解。</small></div></li>
            <li><span aria-hidden="true">02</span><div><b>練習與解題：先思考</b><small>先自行思考；本機 AI 可協助出題與初步學習，完整詳解可接 Google AI。</small></div></li>
            <li><span aria-hidden="true">03</span><div><b>自主判斷 AI 回答</b><small>比對教材與脈絡，判斷回答是否可靠與適用。</small></div></li>
            <li><span aria-hidden="true">04</span><div><b>隱私安全與本機／雲端差異</b><small>了解資料在本機處理或傳往雲端服務的不同。</small></div></li>
            <li><span aria-hidden="true">05</span><div><b>登入後接續 AI-Quest 學習流程</b><small>登入完成後，回到自己的閱讀、練習與進度。</small></div></li>
          </ul>
        </div>
      </section>
      <footer className="signin-footer">
        <p>讓工具退到背景</p>
        <h2>把注意力留給 真正想理解的事。</h2>
        <p>你不需要為了學習拼湊一套流程；閱讀、整理與回顧，應該自然地發生在同一個地方。</p>
        <a href="https://ai-quest-a1-backend.b827262.chatgpt.site/">進入學習工作台 →</a>
      </footer>
    </main>
  );
}
