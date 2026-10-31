import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const PAGE_NAMES: Record<string, string> = {
  "/login": "登入", "/admin": "首頁", "/admin/accounts": "帳戶管理",
  "/admin/learning-history": "學習紀錄管理", "/admin/appearance": "介面設定",
  "/admin/site-config": "網站首頁設定", "/admin/exam-snapshots": "高普考資料快照",
  "/admin/ai-analytics": "AI 執行分析", "/admin/ai-providers": "AI Provider／金鑰",
  "/admin/ai-quota-center": "AI 每日配額中心", "/admin/ai-quality-evaluations": "AI 品質評測",
  "/admin/books": "書本列表", "/admin/books/new": "新增書本"
};

export function AdminPageTitle() {
  const { pathname } = useLocation();
  const name = PAGE_NAMES[pathname] ?? (pathname.endsWith("/chapters") ? "書本章節管理" : pathname.endsWith("/qa") ? "問答管理" : pathname.startsWith("/admin/books/") ? "書本管理" : "管理後台");
  useEffect(() => {
    document.title = `${name} · iBrain AI`;
    return () => { document.title = "iBrain AI 管理後台"; };
  }, [name]);
  return null;
}
