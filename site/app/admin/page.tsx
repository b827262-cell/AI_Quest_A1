"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AdminShell } from "./AdminShell";
import { readAdminIdentity, type AdminIdentityState } from "./admin-identity";

export default function AdminPage() {
  const [identity, setIdentity] = useState<AdminIdentityState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setIdentity({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void readAdminIdentity(controller.signal).then((result) => {
      if (!controller.signal.aborted) setIdentity(result);
    });
    return () => controller.abort();
  }, [attempt]);

  if (identity.status !== "authorized") {
    const messages = {
      loading: ["正在確認管理員身分", "請稍候。"],
      unauthenticated: ["尚未登入", "請先透過平台登入，再重新開啟管理後台。"],
      forbidden: ["沒有管理員權限", "目前的帳號無法使用管理後台。"],
      error: ["無法確認管理員身分", "連線或服務暫時發生問題，請稍後重試。"],
    } as const;
    const [heading, detail] = messages[identity.status];
    return (
      <main className="admin-gate">
        <section className="admin-gate-card" role="status" aria-live="polite">
          <h1>{heading}</h1>
          <p>{detail}</p>
          {identity.status === "error" && <button type="button" onClick={retry}>重試</button>}
          <Link href="/">返回首頁</Link>
        </section>
      </main>
    );
  }

  return <AdminShell user={identity.user} />;
}
