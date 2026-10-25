import Link from "next/link";
import type { AdminUser } from "./admin-identity";

const pendingSections = [
  ["管理後台", "帳戶管理", "學習紀錄管理", "介面設定", "網站首頁設定", "高普考資料快照", "AI 執行分析", "AI Provider／金鑰", "AI 每日配額中心", "AI 品質評測"],
  ["智能書本管理", "書本列表", "新增書本"],
];

export function AdminShell({ user }: { user: AdminUser }) {
  return (
    <div className="admin-page admin-shell-page">
      <header className="admin-topbar">
        <Link href="/admin" className="admin-shell-brand" aria-label="管理後台首頁">
          <span className="admin-brand-mark" aria-hidden="true">iB</span>
          <strong>AI-SmartBook 管理後台</strong>
        </Link>
        <div className="admin-account">
          <Link href="/">網站首頁</Link>
          <span>{user.displayName}</span>
          <b aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</b>
        </div>
      </header>
      <aside className="admin-sidebar" aria-label="管理選單">
        <nav aria-label="已開放頁面"><Link href="/admin" aria-current="page" className="admin-shell-nav-active">首頁</Link></nav>
        {pendingSections.map(([group, ...items]) => (
          <div className="admin-shell-nav-group" key={group}>
            <h2>{group}</h2>
            <ul>{items.map((item) => <li key={item}>{item}<small>待提供</small></li>)}</ul>
          </div>
        ))}
      </aside>
      <main className="admin-content">
        <div className="admin-heading"><div><h1>管理後台</h1><p>管理員身分已確認。</p></div></div>
        <section className="admin-panel admin-shell-empty" aria-labelledby="admin-shell-heading">
          <h2 id="admin-shell-heading">管理功能準備中</h2>
          <p>總覽與各項管理功能會在資料與權限契約確認後逐步提供。</p>
        </section>
      </main>
    </div>
  );
}
