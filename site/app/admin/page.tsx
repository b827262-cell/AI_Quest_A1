"use client";

import { useState } from "react";

const ranges = ["最近一週", "最近一月", "全部"];
const navItems = ["首頁", "帳戶管理", "介面設定", "網站首頁設定", "AI 執行分析", "AI Provider／金鑰", "AI 每日配額中心", "AI 品質評測"];
const keywords = ["用例子解釋 (9)", "解析第一題 (7)", "整理這頁重點 (6)", "本章有考題 (6)", "IASB (5)", "IAS (4)", "IFRS (4)", "是什麼關係 (4)", "關鍵字找考題 (3)", "Test (3)", "question (2)", "service (1)", "type (1)", "warran (1)", "QA (1)", "regression (1)", "負債 (1)", "資本公積 (1)", "火星公司 (1)", "本書三大理由 (1)"];

function Brand() { return <span className="admin-brand-mark" aria-hidden="true">iB</span>; }

export default function AdminPage() {
  const [activeNav, setActiveNav] = useState("首頁");
  const [range, setRange] = useState("最近一月");
  const multiplier = range === "最近一週" ? 0.34 : range === "全部" ? 1.68 : 1;
  const totals = [93, 0, 93, 107].map((number) => Math.round(number * multiplier));

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <a href="/admin" aria-label="管理後台首頁"><Brand /></a>
        <div className="admin-account"><a href="/">首頁</a><span>admin</span><b>A</b><button type="button">登出</button></div>
      </header>
      <aside className="admin-sidebar" aria-label="管理選單">
        <p className="admin-side-title">管理後台</p>
        <nav>
          {navItems.map((item) => <button type="button" className={activeNav === item ? "active" : ""} onClick={() => setActiveNav(item)} key={item}>{item}</button>)}
        </nav>
        <h2>智能書本管理</h2>
        <nav>
          <button type="button" className={activeNav === "書本列表" ? "active" : ""} onClick={() => setActiveNav("書本列表")}>書本列表</button>
          <button type="button" className={activeNav === "新增書本" ? "active" : ""} onClick={() => setActiveNav("新增書本")}>新增書本</button>
        </nav>
      </aside>
      <section className="admin-content">
        <div className="admin-heading">
          <div><h1>{activeNav === "首頁" ? "管理後台" : activeNav}</h1><p>{activeNav === "首頁" ? "總覽近期使用概況、問答趨勢與學生提問紀錄" : "此區塊可由後端資料連結後管理與分析"}</p></div>
          <div className="range-tabs" role="tablist" aria-label="資料期間">{ranges.map((item) => <button type="button" role="tab" aria-selected={range === item} onClick={() => setRange(item)} className={range === item ? "selected" : ""} key={item}>{item}</button>)}</div>
        </div>

        <div className="metric-grid">
          {[{label:"總用戶數",note:"前台累計使用者",value:totals[0]}, {label:"活躍用戶",note:"最近 15 分鐘活動",value:totals[1]}, {label:"總對話數",note:"累計對話 session",value:totals[2]}, {label:"總訊息數",note:"提問 + 回覆累計",value:totals[3]}].map((metric) => <article className="metric-card" key={metric.label}><p>{metric.label}</p><strong>{metric.value}</strong><span>{metric.note}</span></article>)}
        </div>

        <div className="report-grid">
          <article className="admin-panel trend-panel"><h2>每日對話趨勢</h2><p>依學生提問紀錄統計每日對話數（{range}）</p><div className="legend"><i />對話數</div><div className="empty-chart">所選範圍內尚無對話資料。</div></article>
          <article className="admin-panel subject-panel"><h2>熱門科目統計</h2><p>各科目的提問數量分布</p><div className="subject-row"><span>中級會計學</span><b>{Math.round(49 * multiplier)} 次</b></div><div className="subject-row"><span>商研</span><b>{Math.max(1, Math.round(4 * multiplier))} 次</b></div></article>
        </div>
        <article className="admin-panel keyword-panel"><h2>常見問題關鍵字</h2><p>學生最常提問的關鍵字（前 20 個）</p><div className="keyword-list">{keywords.map((keyword) => <button type="button" onClick={() => setActiveNav("AI 執行分析")} key={keyword}>{keyword}</button>)}</div></article>
      </section>
    </main>
  );
}
