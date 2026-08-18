"use client";

import { useState } from "react";

const demoQuestions = [
  {
    label: "數學解題",
    question: "數學題目要怎麼整理已知條件？",
    answer:
      "先把題目拆成「已知、未知、關係式」三欄，再用一句話說明要找什麼。這樣每一步推導都會有清楚的依據。",
  },
  {
    label: "程式設計",
    question: "如何把複雜的程式問題拆成小步驟？",
    answer:
      "先確認輸入與輸出，再把流程拆成可獨立測試的小函式；最後用一個最小案例驗證每個步驟。",
  },
  {
    label: "教材問答",
    question: "請示範如何從教材整理一個重點。",
    answer:
      "可以用「概念 → 例子 → 自我檢查」三段式：先寫一句自己的定義，再補一個教材中的例子，最後寫下仍不確定的地方。",
  },
];

const featureCards = [
  {
    number: "01",
    icon: "✦",
    title: "先問再學",
    text: "不用先找到正確關鍵字，直接用自然語言說出卡住的地方，AI 助教會陪你拆解。",
    tone: "blue",
  },
  {
    number: "02",
    icon: "▤",
    title: "書本變成對話",
    text: "把 PDF 教材放進智慧書庫，閱讀、章節與知識庫問答集中在同一個學習空間。",
    tone: "yellow",
  },
  {
    number: "03",
    icon: "↗",
    title: "看見自己的進度",
    text: "從閱讀紀錄、學習點數到成就摘要，把每一次完成都留成下一步的線索。",
    tone: "green",
  },
];

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><span>✦</span></span>;
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedQuestion = demoQuestions[activeQuestion];

  return (
    <main className="site-shell">
      <div className="announcement">
        <span className="announcement-dot" aria-hidden="true" />
        AI-SmartBook 學習工作台 · 學生端 R1 已完成核心體驗
        <a href="#progress">查看完成內容 <Arrow /></a>
      </div>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="AI-SmartBook 首頁">
          <BrandMark />
          <span>AI-SmartBook</span>
        </a>
        <nav className={`main-nav ${menuOpen ? "is-open" : ""}`} aria-label="主要導覽">
          <a href="#experience" onClick={() => setMenuOpen(false)}>學習體驗</a>
          <a href="#features" onClick={() => setMenuOpen(false)}>功能</a>
          <a href="#progress" onClick={() => setMenuOpen(false)}>完成進度</a>
          <a className="nav-cta" href="#start" onClick={() => setMenuOpen(false)}>開始探索 <Arrow /></a>
        </nav>
        <button
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? "關閉選單" : "開啟選單"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span /><span /><span />
        </button>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>SMART LEARNING, HUMAN PACE</span><i /></div>
          <h1>把每一次閱讀，<br /><em>變成會前進的學習。</em></h1>
          <p className="hero-lede">
            AI-SmartBook 把提問、教材與進度放在一起。從「我不懂」開始，找到下一個真正懂了的瞬間。
          </p>
          <div className="hero-actions" id="start">
            <a className="button button-primary" href="#experience">試用學習助教 <Arrow /></a>
            <a className="button button-quiet" href="#features">認識功能 <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-note"><span className="avatar-stack"><i>A</i><i>I</i><i>+</i></span><span>為自主學習者設計 · 從今天的問題開始</span></div>
        </div>

        <div className="hero-visual" aria-label="AI-SmartBook 學習工作台預覽">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="visual-label label-top">YOUR LEARNING<br /><strong>IN MOTION</strong></div>
          <div className="workspace-card">
            <div className="workspace-topbar"><div className="mini-brand"><BrandMark /><span>學習工作台</span></div><span className="online-pill"><i />AI 在線</span></div>
            <div className="workspace-body">
              <div className="workspace-sidebar">
                <span className="side-kicker">今天的學習</span>
                <div className="side-active"><span>✦</span> AI 助教</div>
                <div className="side-row"><span>▤</span> 我的書庫</div>
                <div className="side-row"><span>◒</span> 學習進度</div>
                <div className="side-divider" />
                <span className="side-kicker">最近閱讀</span>
                <div className="book-row"><i className="book-cover coral" /><span>資通安全<br /><small>第 03 章</small></span></div>
                <div className="book-row"><i className="book-cover navy" /><span>學習方法<br /><small>第 01 章</small></span></div>
              </div>
              <div className="workspace-main">
                <div className="workspace-greeting"><span>星期一，準備好一起解題了嗎？</span><strong>今天想學習什麼？</strong></div>
                <div className="fake-question"><span>⌕</span><span>輸入你的問題……</span><button type="button">送出 <Arrow /></button></div>
                <div className="workspace-section-title"><span>快速開始</span><small>選一個方向，讓思緒動起來</small></div>
                <div className="quick-chips"><span>程式設計</span><span>數學解題</span><span>教材問答</span></div>
                <div className="progress-card"><div><small>本週學習進度</small><strong>68%</strong><span>比上週多 12 分鐘</span></div><div className="progress-ring"><span>4.2h</span></div></div>
              </div>
            </div>
          </div>
          <div className="visual-sticker"><span>+</span><strong>learn<br />with clarity</strong></div>
        </div>
      </section>

      <section className="trust-strip" aria-label="平台特色">
        <span className="trust-intro">一個更靠近學習現場的 AI 空間</span>
        <span><b>01</b> 自然提問</span><span><b>02</b> 教材串聯</span><span><b>03</b> 進度可見</span>
      </section>

      <section className="experience-section" id="experience">
        <div className="section-heading">
          <div><div className="eyebrow"><span>TRY THE FLOW</span><i /></div><h2>先問一個問題，<br /><em>看看學習可以多自然。</em></h2></div>
          <p>這裡先用一個小小的示範，讓你感受 AI-SmartBook 的回答方式：清楚、分段，而且願意陪你想。</p>
        </div>
        <div className="demo-panel">
          <div className="demo-tabs" role="tablist" aria-label="示範問題">
            {demoQuestions.map((item, index) => <button key={item.label} type="button" role="tab" aria-selected={activeQuestion === index} className={activeQuestion === index ? "active" : ""} onClick={() => setActiveQuestion(index)}>{item.label}</button>)}
          </div>
          <div className="demo-content">
            <div className="question-column"><span className="demo-kicker">你的問題</span><h3>{selectedQuestion.question}</h3><div className="demo-meta"><span className="tiny-avatar">你</span><span>訪客體驗 · 可從問題開始</span></div></div>
            <div className="answer-column"><div className="answer-heading"><span className="assistant-mark">✦</span><span>AI-SmartBook 學習助教</span><span className="answer-status">示範回答</span></div><p>{selectedQuestion.answer}</p><div className="answer-footer"><span>回答重點已整理</span><button type="button" onClick={() => setActiveQuestion((activeQuestion + 1) % demoQuestions.length)}>換一個問題 <Arrow /></button></div></div>
          </div>
        </div>
      </section>

      <section className="features-section" id="features">
        <div className="section-heading compact"><div><div className="eyebrow"><span>BUILT AROUND YOU</span><i /></div><h2>學習的每一步，<em>都有位置。</em></h2></div><p>從第一個問題到最後一次複習，把分散的學習動作整理成一條看得見的路。</p></div>
        <div className="feature-grid">{featureCards.map((feature) => <article className={`feature-card ${feature.tone}`} key={feature.number}><div className="feature-top"><span className="feature-icon">{feature.icon}</span><span>{feature.number}</span></div><h3>{feature.title}</h3><p>{feature.text}</p><a href="#start" aria-label={`了解${feature.title}`}>探索這個功能 <Arrow /></a></article>)}</div>
      </section>

      <section className="progress-section" id="progress">
        <div className="progress-copy"><div className="eyebrow"><span>WHAT&apos;S READY</span><i /></div><h2>不是等待中的藍圖，<br /><em>是已經能走進去的空間。</em></h2><p>AI-SmartBook 學生端的核心學習路徑已經建立。你可以從公開提問開始，再逐步進入自己的書庫與學習紀錄。</p><a className="text-link" href="#start">從首頁開始 <Arrow /></a></div>
        <div className="roadmap-card"><div className="roadmap-head"><span>學生端 R1</span><strong>核心體驗完成</strong></div><div className="roadmap-line"><i /><i /><i /><i /></div><div className="roadmap-list"><div><span className="check">✓</span><p><strong>公開 AI 提問</strong><small>不用登入，也能先問出第一步</small></p><em>完成</em></div><div><span className="check">✓</span><p><strong>智慧書庫與閱讀器</strong><small>教材、章節與知識庫問答串聯</small></p><em>完成</em></div><div><span className="check">✓</span><p><strong>學習進度與成就</strong><small>讓閱讀紀錄變成可回看的成長</small></p><em>完成</em></div><div><span className="check">✓</span><p><strong>行動版閱讀體驗</strong><small>在手機上也能專注閱讀與操作</small></p><em>完成</em></div></div></div>
      </section>

      <section className="final-cta"><div><span className="cta-mark">✦</span><h2>今天的問題，<br /><em>就從這裡開始。</em></h2><p>讓 AI 幫你把「不懂」變成下一個可以前進的小步驟。</p></div><a className="button button-light" href="#experience">開啟學習助教 <Arrow /></a></section>

      <footer className="site-footer"><a className="brand" href="#top"><BrandMark /><span>AI-SmartBook</span></a><span>AI 不是替你學習，而是陪你把學習走完。</span><span>© 2026 AI-SmartBook</span></footer>
    </main>
  );
}
