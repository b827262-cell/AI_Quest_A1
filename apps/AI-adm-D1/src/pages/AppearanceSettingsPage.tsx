import { useEffect, useRef, useState } from "react";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "@ai-smartbook/schema";
import { adminApi } from "../api";
import { useAppearance } from "../appearance";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { AdminCard } from "../components/admin/AdminCard";

type Toast = { kind: "ok" | "err"; text: string } | null;

/** Image with graceful fallback so an invalid URL never breaks the page. */
function SafeIcon({ url, size, fallback }: { url: string; size: number; fallback: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: size, height: size, objectFit: "contain" }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="admin-brand-mark"
      style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
    >
      {fallback}
    </span>
  );
}

export function AppearanceSettingsPage() {
  const { settings, refresh } = useAppearance();
  const [form, setForm] = useState<AppearanceSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const brandInput = useRef<HTMLInputElement>(null);

  // Seed the form once settings are loaded from the server.
  useEffect(() => setForm(settings), [settings]);

  function setField<K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setNum(key: keyof AppearanceSettings, raw: string) {
    const n = Number.parseInt(raw, 10);
    setField(key, (Number.isFinite(n) ? n : 0) as AppearanceSettings[typeof key]);
  }
  function setBool(key: keyof AppearanceSettings, val: boolean) {
    setField(key, val as AppearanceSettings[typeof key]);
  }

  async function save(next: AppearanceSettings) {
    setSaving(true);
    setToast(null);
    try {
      await adminApi.updateAppearanceSettings(next);
      await refresh();
      setToast({ kind: "ok", text: "已儲存設定" });
    } catch (e) {
      setToast({ kind: "err", text: `儲存失敗：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function onUpload(
    field:
      | "headerLogoUrl"
      | "bannerIconUrl"
      | "studentPageBackgroundImageUrl"
      | "studentHeaderBrandLogoUrl",
    file: File | undefined
  ) {
    if (!file) return;
    setToast(null);
    try {
      const { url } = await adminApi.uploadAppearanceImage(file);
      setField(field, url as AppearanceSettings[typeof field]);
      setToast({ kind: "ok", text: "圖片已上傳，請記得按儲存" });
    } catch (e) {
      setToast({ kind: "err", text: `上傳失敗：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function resetDefaults() {
    setForm(DEFAULT_APPEARANCE);
    void save(DEFAULT_APPEARANCE);
  }

  return (
    <div>
      <AdminPageHeader
        title="介面設定"
        subtitle="自訂後台導覽、Header 與首頁 Banner 的顯示內容（無需改程式碼）"
        actions={
          <>
            <button className="admin-btn ghost" onClick={resetDefaults} disabled={saving}>
              還原預設值
            </button>
            <button className="admin-btn" onClick={() => void save(form)} disabled={saving}>
              {saving ? "儲存中…" : "儲存設定"}
            </button>
          </>
        }
      />

      {toast && (
        <p className={toast.kind === "ok" ? "muted" : "error"} role="status">
          {toast.text}
        </p>
      )}

      <AdminCard title="目前設定預覽">
        <div className="appearance-preview">
          <div className="appearance-preview-row" style={{ gap: form.headerLogoTextGap }}>
            <SafeIcon url={form.headerLogoUrl} size={form.headerLogoSize} fallback="iB" />
            <strong>{form.systemName}</strong>
          </div>
          <div
            className="appearance-preview-banner"
            style={{
              paddingTop: form.bannerPaddingTop,
              paddingBottom: form.bannerPaddingBottom,
              maxWidth: form.bannerMaxWidth
            }}
          >
            <div className="appearance-preview-row" style={{ gap: form.bannerIconTitleGap }}>
              <SafeIcon url={form.bannerIconUrl} size={form.bannerIconSize} fallback="📘" />
              <div>
                <h2 style={{ margin: 0 }}>{form.bannerTitle}</h2>
                <p className="muted" style={{ margin: 0 }}>{form.bannerSubtitle}</p>
              </div>
            </div>
            <div className="appearance-preview-search">
              <input placeholder={form.searchPlaceholder} readOnly />
              <button className="admin-btn" type="button">{form.assistantButtonText}</button>
            </div>
          </div>
        </div>
      </AdminCard>

      <AdminCard title="A. 導覽設定">
        <label>左側選單「首頁」顯示文字（dashboardNavLabel）</label>
        <input value={form.dashboardNavLabel} onChange={(e) => setField("dashboardNavLabel", e.target.value)} />
      </AdminCard>

      <AdminCard title="B. Header 設定">
        <label>系統名稱（systemName）</label>
        <input value={form.systemName} onChange={(e) => setField("systemName", e.target.value)} />

        <label>Logo 圖片網址（headerLogoUrl）</label>
        <input value={form.headerLogoUrl} onChange={(e) => setField("headerLogoUrl", e.target.value)} placeholder="https://… 或上傳" />
        <div className="row" style={{ margin: "8px 0" }}>
          <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => void onUpload("headerLogoUrl", e.target.files?.[0])} />
          <button type="button" className="admin-btn secondary" onClick={() => logoInput.current?.click()}>上傳圖片</button>
        </div>

        <label>Logo 大小 px（headerLogoSize）</label>
        <input type="number" value={form.headerLogoSize} onChange={(e) => setNum("headerLogoSize", e.target.value)} />

        <label>Logo 與文字距離 px（headerLogoTextGap）</label>
        <input type="number" value={form.headerLogoTextGap} onChange={(e) => setNum("headerLogoTextGap", e.target.value)} />
      </AdminCard>

      <AdminCard title="C. Banner 設定">
        <label>Banner 標題（bannerTitle）</label>
        <input value={form.bannerTitle} onChange={(e) => setField("bannerTitle", e.target.value)} />

        <label>Banner 副標題（bannerSubtitle）</label>
        <input value={form.bannerSubtitle} onChange={(e) => setField("bannerSubtitle", e.target.value)} />

        <label>Banner 圖片網址（bannerIconUrl）</label>
        <input value={form.bannerIconUrl} onChange={(e) => setField("bannerIconUrl", e.target.value)} placeholder="https://… 或上傳" />
        <div className="row" style={{ margin: "8px 0" }}>
          <input ref={iconInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => void onUpload("bannerIconUrl", e.target.files?.[0])} />
          <button type="button" className="admin-btn secondary" onClick={() => iconInput.current?.click()}>上傳圖片</button>
        </div>

        <label>Banner 圖標大小 px（bannerIconSize）</label>
        <input type="number" value={form.bannerIconSize} onChange={(e) => setNum("bannerIconSize", e.target.value)} />

        <label>圖標與標題距離 px（bannerIconTitleGap）</label>
        <input type="number" value={form.bannerIconTitleGap} onChange={(e) => setNum("bannerIconTitleGap", e.target.value)} />

        <label>Banner 上 padding px（bannerPaddingTop）</label>
        <input type="number" value={form.bannerPaddingTop} onChange={(e) => setNum("bannerPaddingTop", e.target.value)} />

        <label>Banner 下 padding px（bannerPaddingBottom）</label>
        <input type="number" value={form.bannerPaddingBottom} onChange={(e) => setNum("bannerPaddingBottom", e.target.value)} />

        <label>Banner 最大寬度 px（bannerMaxWidth）</label>
        <input type="number" value={form.bannerMaxWidth} onChange={(e) => setNum("bannerMaxWidth", e.target.value)} />

        <label>搜尋框 placeholder（searchPlaceholder）</label>
        <input value={form.searchPlaceholder} onChange={(e) => setField("searchPlaceholder", e.target.value)} />

        <label>助教群按鈕文字（assistantButtonText）</label>
        <input value={form.assistantButtonText} onChange={(e) => setField("assistantButtonText", e.target.value)} />
      </AdminCard>

      <AdminCard title="D. 前台首頁版型設定">
        <h4 style={{ margin: "0 0 8px" }}>Hero 版型</h4>
        <label>Hero 版型（studentHeroVariant）</label>
        <select
          value={form.studentHeroVariant}
          onChange={(e) => setField("studentHeroVariant", e.target.value as AppearanceSettings["studentHeroVariant"])}
        >
          <option value="compact">compact（精簡）</option>
          <option value="card">card（白色卡片）</option>
        </select>

        <label className="appearance-check">
          <input type="checkbox" checked={form.studentHeroShowCard} onChange={(e) => setBool("studentHeroShowCard", e.target.checked)} />
          顯示 Hero 卡片背景（studentHeroShowCard）
        </label>

        <label>Hero 上 padding px（0–120）</label>
        <input type="number" min={0} max={120} value={form.studentHeroPaddingTop} onChange={(e) => setNum("studentHeroPaddingTop", e.target.value)} />
        <label>Hero 下 padding px（0–120）</label>
        <input type="number" min={0} max={120} value={form.studentHeroPaddingBottom} onChange={(e) => setNum("studentHeroPaddingBottom", e.target.value)} />
        <label>標題字體 px（12–48）</label>
        <input type="number" min={12} max={48} value={form.studentHeroTitleFontSize} onChange={(e) => setNum("studentHeroTitleFontSize", e.target.value)} />
        <label>副標題字體 px（12–48）</label>
        <input type="number" min={12} max={48} value={form.studentHeroSubtitleFontSize} onChange={(e) => setNum("studentHeroSubtitleFontSize", e.target.value)} />
        <label>搜尋列最大寬度 px（480–1440）</label>
        <input type="number" min={480} max={1440} value={form.studentHeroSearchMaxWidth} onChange={(e) => setNum("studentHeroSearchMaxWidth", e.target.value)} />
        <label>搜尋框高度 px（28–80）</label>
        <input type="number" min={28} max={80} value={form.studentHeroSearchHeight} onChange={(e) => setNum("studentHeroSearchHeight", e.target.value)} />
        <label className="appearance-check">
          <input type="checkbox" checked={form.assistantButtonVisible} onChange={(e) => setBool("assistantButtonVisible", e.target.checked)} />
          顯示助教群按鈕（assistantButtonVisible）
        </label>
        <label>Hero 標題對齊（studentHeroTextAlign）</label>
        <select
          value={form.studentHeroTextAlign}
          onChange={(e) => setField("studentHeroTextAlign", e.target.value as AppearanceSettings["studentHeroTextAlign"])}
        >
          <option value="center">center（置中）</option>
          <option value="left">left（靠左）</option>
        </select>

        <h4 style={{ margin: "16px 0 8px" }}>書籍列表版型</h4>
        <label>內容最大寬度 px（480–1440）</label>
        <input type="number" min={480} max={1440} value={form.studentContentMaxWidth} onChange={(e) => setNum("studentContentMaxWidth", e.target.value)} />
        <label>分類間距 px（0–120）</label>
        <input type="number" min={0} max={120} value={form.studentCategoryGap} onChange={(e) => setNum("studentCategoryGap", e.target.value)} />
        <label>分類標題字體 px（12–48）</label>
        <input type="number" min={12} max={48} value={form.studentCategoryTitleFontSize} onChange={(e) => setNum("studentCategoryTitleFontSize", e.target.value)} />
        <label>書卡寬度 px（120–260）</label>
        <input type="number" min={120} max={260} value={form.studentBookCardWidth} onChange={(e) => setNum("studentBookCardWidth", e.target.value)} />
        <label>封面高度 px（140–360）</label>
        <input type="number" min={140} max={360} value={form.studentBookCoverHeight} onChange={(e) => setNum("studentBookCoverHeight", e.target.value)} />
        <label>書卡間距 px（8–40）</label>
        <input type="number" min={8} max={40} value={form.studentBookGridGap} onChange={(e) => setNum("studentBookGridGap", e.target.value)} />
        <label>書卡圓角 px（0–32）</label>
        <input type="number" min={0} max={32} value={form.studentBookCardRadius} onChange={(e) => setNum("studentBookCardRadius", e.target.value)} />
        <label>封面填充方式（studentBookCoverFit）</label>
        <select
          value={form.studentBookCoverFit}
          onChange={(e) => setField("studentBookCoverFit", e.target.value as AppearanceSettings["studentBookCoverFit"])}
        >
          <option value="contain">contain（教科書建議）</option>
          <option value="cover">cover</option>
        </select>
        <label>無封面樣式（studentFallbackCoverMode）</label>
        <select
          value={form.studentFallbackCoverMode}
          onChange={(e) => setField("studentFallbackCoverMode", e.target.value as AppearanceSettings["studentFallbackCoverMode"])}
        >
          <option value="simple">simple（淡灰）</option>
          <option value="gradient">gradient（淡藍漸層）</option>
        </select>

        <h4 style={{ margin: "16px 0 8px" }}>分類顯示</h4>
        <label>分類圖示（categoryIcon）</label>
        <input value={form.categoryIcon} onChange={(e) => setField("categoryIcon", e.target.value)} />
        <label>數量單位後綴（categoryCountSuffix）</label>
        <input value={form.categoryCountSuffix} onChange={(e) => setField("categoryCountSuffix", e.target.value)} />
        <label className="appearance-check">
          <input type="checkbox" checked={form.showCategoryDivider} onChange={(e) => setBool("showCategoryDivider", e.target.checked)} />
          顯示分類分隔線（showCategoryDivider）
        </label>
      </AdminCard>

      <AdminCard title="E. 前台主頁背景設定">
        <p className="muted" style={{ marginTop: 0 }}>
          建議正式書城首頁使用白底；若要活動頁或品牌頁，可改成漸層或背景圖。
        </p>

        <label>背景模式（studentPageBackgroundMode）</label>
        <select
          value={form.studentPageBackgroundMode}
          onChange={(e) =>
            setField("studentPageBackgroundMode", e.target.value as AppearanceSettings["studentPageBackgroundMode"])
          }
        >
          <option value="solid">白色 / 純色（solid）</option>
          <option value="gradient">漸層（gradient）</option>
          <option value="image">圖片（image）</option>
        </select>

        <label>背景純色（studentPageBackgroundColor）</label>
        <input className="appearance-color" type="color" value={form.studentPageBackgroundColor} onChange={(e) => setField("studentPageBackgroundColor", e.target.value)} />

        <label>漸層起始色（studentPageBackgroundGradientFrom）</label>
        <input className="appearance-color" type="color" value={form.studentPageBackgroundGradientFrom} onChange={(e) => setField("studentPageBackgroundGradientFrom", e.target.value)} />

        <label>漸層結束色（studentPageBackgroundGradientTo）</label>
        <input className="appearance-color" type="color" value={form.studentPageBackgroundGradientTo} onChange={(e) => setField("studentPageBackgroundGradientTo", e.target.value)} />

        <label>背景圖片網址（studentPageBackgroundImageUrl）</label>
        <input value={form.studentPageBackgroundImageUrl} onChange={(e) => setField("studentPageBackgroundImageUrl", e.target.value)} placeholder="https://… 或上傳" />
        <div className="row" style={{ margin: "8px 0" }}>
          <input ref={bgInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => void onUpload("studentPageBackgroundImageUrl", e.target.files?.[0])} />
          <button type="button" className="admin-btn secondary" onClick={() => bgInput.current?.click()}>上傳背景圖</button>
        </div>

        <label>背景圖填充（studentPageBackgroundImageFit）</label>
        <select
          value={form.studentPageBackgroundImageFit}
          onChange={(e) =>
            setField("studentPageBackgroundImageFit", e.target.value as AppearanceSettings["studentPageBackgroundImageFit"])
          }
        >
          <option value="cover">cover</option>
          <option value="contain">contain</option>
          <option value="auto">auto</option>
        </select>

        <label>背景圖位置（studentPageBackgroundImagePosition）</label>
        <input value={form.studentPageBackgroundImagePosition} onChange={(e) => setField("studentPageBackgroundImagePosition", e.target.value)} placeholder="center top" />

        <label>背景圖重複（studentPageBackgroundImageRepeat）</label>
        <select
          value={form.studentPageBackgroundImageRepeat}
          onChange={(e) =>
            setField("studentPageBackgroundImageRepeat", e.target.value as AppearanceSettings["studentPageBackgroundImageRepeat"])
          }
        >
          <option value="no-repeat">no-repeat</option>
          <option value="repeat">repeat</option>
        </select>
      </AdminCard>

      <AdminCard title="F. 前台 Header / 導覽列設定">
        <h4 style={{ margin: "0 0 8px" }}>品牌區</h4>
        <label>品牌圖示網址（studentHeaderBrandLogoUrl）</label>
        <input value={form.studentHeaderBrandLogoUrl} onChange={(e) => setField("studentHeaderBrandLogoUrl", e.target.value)} placeholder="https://… 或上傳（留空用內建 icon）" />
        <div className="row" style={{ margin: "8px 0" }}>
          <input ref={brandInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => void onUpload("studentHeaderBrandLogoUrl", e.target.files?.[0])} />
          <button type="button" className="admin-btn secondary" onClick={() => brandInput.current?.click()}>上傳品牌圖示</button>
        </div>
        <label>品牌圖示大小 px（12–96）</label>
        <input type="number" min={12} max={96} value={form.studentHeaderBrandLogoSize} onChange={(e) => setNum("studentHeaderBrandLogoSize", e.target.value)} />
        <label>品牌文字（studentHeaderBrandText）</label>
        <input value={form.studentHeaderBrandText} onChange={(e) => setField("studentHeaderBrandText", e.target.value)} />
        <label>品牌文字顏色（studentHeaderBrandTextColor）</label>
        <input className="appearance-color" type="color" value={form.studentHeaderBrandTextColor} onChange={(e) => setField("studentHeaderBrandTextColor", e.target.value)} />
        <label>品牌文字大小 px（12–40）</label>
        <input type="number" min={12} max={40} value={form.studentHeaderBrandFontSize} onChange={(e) => setNum("studentHeaderBrandFontSize", e.target.value)} />
        <label>圖示與文字間距 px（0–40）</label>
        <input type="number" min={0} max={40} value={form.studentHeaderBrandGap} onChange={(e) => setNum("studentHeaderBrandGap", e.target.value)} />

        <h4 style={{ margin: "16px 0 8px" }}>Header 背景</h4>
        <label>Header 背景色（studentHeaderBackgroundColor）</label>
        <input className="appearance-color" type="color" value={form.studentHeaderBackgroundColor} onChange={(e) => setField("studentHeaderBackgroundColor", e.target.value)} />
        <label>Header 底線顏色（studentHeaderBorderColor）</label>
        <input className="appearance-color" type="color" value={form.studentHeaderBorderColor} onChange={(e) => setField("studentHeaderBorderColor", e.target.value)} />
        <label className="appearance-check">
          <input type="checkbox" checked={form.studentHeaderShadowEnabled} onChange={(e) => setBool("studentHeaderShadowEnabled", e.target.checked)} />
          啟用 Header 陰影（studentHeaderShadowEnabled）
        </label>

        <h4 style={{ margin: "16px 0 8px" }}>首頁按鈕</h4>
        <label>按鈕文字（studentHeaderHomeButtonLabel）</label>
        <input value={form.studentHeaderHomeButtonLabel} onChange={(e) => setField("studentHeaderHomeButtonLabel", e.target.value)} />
        <label>按鈕背景色（studentHeaderHomeButtonBg）</label>
        <input className="appearance-color" type="color" value={form.studentHeaderHomeButtonBg} onChange={(e) => setField("studentHeaderHomeButtonBg", e.target.value)} />
        <label>按鈕文字色（studentHeaderHomeButtonTextColor）</label>
        <input className="appearance-color" type="color" value={form.studentHeaderHomeButtonTextColor} onChange={(e) => setField("studentHeaderHomeButtonTextColor", e.target.value)} />
        <label>按鈕圓角 px（0–999）</label>
        <input type="number" min={0} max={999} value={form.studentHeaderHomeButtonRadius} onChange={(e) => setNum("studentHeaderHomeButtonRadius", e.target.value)} />
        <label>按鈕高度 px（24–64）</label>
        <input type="number" min={24} max={64} value={form.studentHeaderHomeButtonHeight} onChange={(e) => setNum("studentHeaderHomeButtonHeight", e.target.value)} />
        <label>按鈕左右 padding px（4–48）</label>
        <input type="number" min={4} max={48} value={form.studentHeaderHomeButtonHorizontalPadding} onChange={(e) => setNum("studentHeaderHomeButtonHorizontalPadding", e.target.value)} />
        <label>按鈕 icon 模式（studentHeaderHomeButtonIconMode）</label>
        <select
          value={form.studentHeaderHomeButtonIconMode}
          onChange={(e) => setField("studentHeaderHomeButtonIconMode", e.target.value as AppearanceSettings["studentHeaderHomeButtonIconMode"])}
        >
          <option value="default">default（內建首頁 icon）</option>
          <option value="image">image（自訂圖示）</option>
        </select>
        <label>按鈕 icon 網址（studentHeaderHomeButtonIconUrl）</label>
        <input value={form.studentHeaderHomeButtonIconUrl} onChange={(e) => setField("studentHeaderHomeButtonIconUrl", e.target.value)} placeholder="https://…（icon 模式為 image 時使用）" />
        <label>按鈕 icon 大小 px（8–40）</label>
        <input type="number" min={8} max={40} value={form.studentHeaderHomeButtonIconSize} onChange={(e) => setNum("studentHeaderHomeButtonIconSize", e.target.value)} />
      </AdminCard>
    </div>
  );
}
