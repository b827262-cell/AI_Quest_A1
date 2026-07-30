import { useEffect, useState } from "react";
import { DEFAULT_SITE_CONFIG, type SiteConfig } from "@ai-smartbook/schema";
import { adminApi } from "../api";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";

type Toast = { kind: "ok" | "err"; text: string } | null;

export function SiteConfigPage() {
  const [form, setForm] = useState<SiteConfig>(DEFAULT_SITE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    let active = true;
    adminApi
      .getSiteConfig()
      .then(({ config }) => active && setForm(config))
      .catch((error) => active && setToast({ kind: "err", text: "載入失敗：" + (error instanceof Error ? error.message : String(error)) }))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  function setField<K extends keyof SiteConfig>(key: K, value: SiteConfig[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(next: SiteConfig) {
    setSaving(true);
    setToast(null);
    try {
      const result = await adminApi.updateSiteConfig(next);
      setForm(result.config);
      setToast({ kind: "ok", text: "首頁設定已儲存，公開首頁會在下次載入時更新。" });
    } catch (error) {
      setToast({ kind: "err", text: "儲存失敗：" + (error instanceof Error ? error.message : String(error)) });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setForm(DEFAULT_SITE_CONFIG);
    void save(DEFAULT_SITE_CONFIG);
  }

  return (
    <div>
      <AdminPageHeader
        title="網站首頁設定"
        subtitle="管理公開 AI 問答入口的品牌文字、訪客額度與登入入口。設定不需要重新建置前端。"
        actions={
          <>
            <button className="admin-btn ghost" type="button" onClick={() => window.open("/", "_blank", "noopener,noreferrer")}>
              預覽首頁
            </button>
            <button className="admin-btn ghost" type="button" onClick={reset} disabled={saving || loading}>
              恢復預設值
            </button>
            <button className="admin-btn" type="button" onClick={() => void save(form)} disabled={saving || loading}>
              {saving ? "儲存中…" : "儲存變更"}
            </button>
          </>
        }
      />

      {toast ? <p className={toast.kind === "ok" ? "muted" : "error"} role="status">{toast.text}</p> : null}
      {loading ? <p className="muted">載入設定中…</p> : null}

      <AdminCard title="公開品牌">
        <div className="site-config-grid">
          <div>
            <label htmlFor="site-title">網站名稱</label>
            <input id="site-title" value={form.siteTitle} maxLength={80} onChange={(event) => setField("siteTitle", event.target.value)} />
          </div>
          <div>
            <label htmlFor="site-subtitle">首頁副標題</label>
            <input id="site-subtitle" value={form.siteSubtitle} maxLength={160} onChange={(event) => setField("siteSubtitle", event.target.value)} />
          </div>
        </div>
        <label htmlFor="home-greeting">首頁主標題</label>
        <input id="home-greeting" value={form.homeGreeting} maxLength={100} onChange={(event) => setField("homeGreeting", event.target.value)} />
        <label htmlFor="home-placeholder">輸入框提示文字</label>
        <input id="home-placeholder" value={form.homeInputPlaceholder} maxLength={120} onChange={(event) => setField("homeInputPlaceholder", event.target.value)} />
      </AdminCard>

      <AdminCard title="訪客問答">
        <label className="appearance-check">
          <input type="checkbox" checked={form.guestAiEnabled} onChange={(event) => setField("guestAiEnabled", event.target.checked)} />
          開放未登入訪客問答
        </label>
        <label htmlFor="guest-limit">每位訪客每日可提問次數（0–100）</label>
        <input
          id="guest-limit"
          type="number"
          min={0}
          max={100}
          value={form.guestDailyLimit}
          onChange={(event) => setField("guestDailyLimit", Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
        />
        <p className="muted site-config-help">公開 Mock 流程每題最多 2,000 字，答案不會保存到正式學習紀錄；後端仍會依 IP 做每日額度與請求間隔限制。</p>
      </AdminCard>

      <AdminCard title="登入與公告">
        <label className="appearance-check">
          <input type="checkbox" checked={form.studentLoginEnabled} onChange={(event) => setField("studentLoginEnabled", event.target.checked)} />
          顯示「學員登入」入口
        </label>
        <label htmlFor="maintenance-notice">系統公告（留空則不顯示）</label>
        <textarea
          id="maintenance-notice"
          value={form.maintenanceNotice}
          maxLength={240}
          rows={3}
          onChange={(event) => setField("maintenanceNotice", event.target.value)}
          placeholder="例如：本週六 02:00–03:00 進行系統維護"
        />
        <p className="muted site-config-help">文字欄位會在後端驗證長度並拒絕 HTML / Script 標籤；不接受 API Key 或模型供應商設定。</p>
      </AdminCard>
    </div>
  );
}
