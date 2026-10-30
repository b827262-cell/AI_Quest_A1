import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export function StudentPageTitle() {
  const { pathname } = useLocation();
  const name = pathname === "/login" ? "登入"
    : pathname === "/knowledge-ai" ? "知識達"
      : pathname === "/dashboard" ? "儀表板"
        : pathname === "/books" ? "書櫃"
          : pathname.startsWith("/books/") ? "閱讀器"
            : pathname === "/profile-completion" ? "個人資料"
              : pathname === "/antiG/institutional-flow" ? "機構流程"
                : pathname.startsWith("/antiG") ? "AntiG" : "首頁";
  useEffect(() => {
    document.title = `${name} · iBrain AI`;
    return () => { document.title = "iBrain AI"; };
  }, [name]);
  return null;
}
