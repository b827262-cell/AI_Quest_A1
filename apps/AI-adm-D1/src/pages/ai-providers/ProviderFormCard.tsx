import type { Dispatch, SetStateAction } from "react";
import { AdminCard } from "../../components/admin/AdminCard";
import {
  PROVIDER_BASE_URL_DEFAULTS,
  PROVIDER_LABELS,
  PROVIDER_MODEL_DEFAULTS,
  type Provider,
  type ProviderForm,
  type ProviderId
} from "./types";

export function ProviderFormCard({
  selectedProvider,
  providerForm,
  setProviderForm,
  busy,
  onSave,
  onToggle
}: {
  selectedProvider: Provider | null;
  providerForm: ProviderForm;
  setProviderForm: Dispatch<SetStateAction<ProviderForm>>;
  busy: boolean;
  onSave: () => void;
  onToggle: () => void;
}) {
  return <AdminCard title={selectedProvider ? `編輯 ${selectedProvider.displayName}` : "新增 Provider"}>
    <div className="admin-form-grid">
      <label>Provider<select value={providerForm.provider} disabled={Boolean(selectedProvider) || busy} onChange={(event) => {
        const provider = event.target.value as ProviderId;
        setProviderForm((current) => ({
          ...current,
          provider,
          displayName: PROVIDER_LABELS[provider],
          baseUrl: PROVIDER_BASE_URL_DEFAULTS[provider] ?? "",
          model: PROVIDER_MODEL_DEFAULTS[provider] ?? ""
        }));
      }}><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="kimi">Kimi</option><option value="qwen">Qwen</option><option value="zai">Z.AI</option></select></label>
      <label>唯一 Slug<input value={providerForm.slug} disabled={busy} placeholder="留白則由顯示名稱產生" onChange={(event) => setProviderForm((current) => ({ ...current, slug: event.target.value }))} maxLength={64} /></label>
      <label>顯示名稱<input value={providerForm.displayName} disabled={busy} onChange={(event) => setProviderForm((current) => ({ ...current, displayName: event.target.value }))} maxLength={80} /></label>
      <label>Base URL（可留白）<input value={providerForm.baseUrl} disabled={busy} placeholder="使用 Provider 預設值" onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
      <label>Model（可留白）<input value={providerForm.model} disabled={busy} placeholder="使用 Provider 預設模型" onChange={(event) => setProviderForm((current) => ({ ...current, model: event.target.value }))} /></label>
      <label>Priority<input type="number" min={0} max={10000} value={providerForm.priority} disabled={busy} onChange={(event) => setProviderForm((current) => ({ ...current, priority: Number(event.target.value) }))} /></label>
    </div>
    <div className="admin-check-row">
      <label><input type="checkbox" checked={providerForm.enabled} disabled={busy} onChange={(event) => setProviderForm((current) => ({ ...current, enabled: event.target.checked }))} /> Provider 啟用</label>
      <label><input type="checkbox" checked={providerForm.isDefault} disabled={busy} onChange={(event) => setProviderForm((current) => ({ ...current, isDefault: event.target.checked }))} /> 預設 Provider</label>
      <label><input type="checkbox" checked={providerForm.isRouterProvider} disabled={busy} onChange={(event) => setProviderForm((current) => ({ ...current, isRouterProvider: event.target.checked }))} /> Router Provider</label>
    </div>
    <div className="admin-action-row">
      <button type="button" className="admin-btn" onClick={onSave} disabled={busy}>{busy ? "處理中…" : "儲存 Provider"}</button>
      {selectedProvider ? <button type="button" className="admin-btn secondary" onClick={onToggle} disabled={busy}>{selectedProvider.enabled ? "停用 Provider" : "啟用 Provider"}</button> : null}
    </div>
    <p className="admin-help">Priority 會先於同層 weight；Credential 的 cooldown 與 failure count 由 Gateway 自動管理。</p>
  </AdminCard>;
}
