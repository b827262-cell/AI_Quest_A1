import type { Dispatch, SetStateAction } from "react";
import {
  EMPTY_QUOTA,
  type CredentialForm,
  type CredentialStatus,
  type Provider,
  type QuotaForm
} from "./types";

export function CredentialFormCard({
  selectedProvider,
  credentialForm,
  setCredentialForm,
  quotaForm,
  setQuotaForm,
  editingCredentialId,
  editingQuotaId,
  setEditingQuotaId,
  credentialErrors,
  busy,
  onSave,
  onReset,
  onSaveQuota
}: {
  selectedProvider: Provider;
  credentialForm: CredentialForm;
  setCredentialForm: Dispatch<SetStateAction<CredentialForm>>;
  quotaForm: QuotaForm;
  setQuotaForm: Dispatch<SetStateAction<QuotaForm>>;
  editingCredentialId: string | null;
  editingQuotaId: string | null;
  setEditingQuotaId: Dispatch<SetStateAction<string | null>>;
  credentialErrors: Record<string, string>;
  busy: boolean;
  onSave: () => void;
  onReset: () => void;
  onSaveQuota: () => void;
}) {
  const credentialFieldError = (field: string) => credentialErrors[field]
    ? <span className="admin-field-error" role="alert">{credentialErrors[field]}</span>
    : null;

  return <>
    <p className="admin-help">完整 Key 只在送出時進入 HTTPS request body，伺服器加密後即不可回讀。編輯既有 Credential 時，Key 欄位留白即可保留原值。</p>
    <div className="admin-form-grid">
      <label>名稱<input value={credentialForm.name} aria-invalid={Boolean(credentialErrors.name)} disabled={busy} maxLength={100} onChange={(event) => setCredentialForm((current) => ({ ...current, name: event.target.value }))} />{credentialFieldError("name")}</label>
      <label>{editingCredentialId ? "替換 API Key（可留白）" : "API Key"}<input type="password" autoComplete="new-password" aria-invalid={Boolean(credentialErrors.apiKey)} value={credentialForm.apiKey} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, apiKey: event.target.value }))} />{credentialFieldError("apiKey")}</label>
      <label>Credential Base URL（可留白）<input value={credentialForm.baseUrl} aria-invalid={Boolean(credentialErrors.baseUrl)} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, baseUrl: event.target.value }))} />{credentialFieldError("baseUrl")}</label>
      {selectedProvider.provider === "gemini" ? <label>Gemini Endpoint Profile<select value={credentialForm.endpointProfile} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, endpointProfile: event.target.value }))}><option value="">Legacy Default（Native）</option><option value="gemini_native">Gemini Native API</option><option value="gemini_openai_compatible">Gemini OpenAI-Compatible API</option></select></label> : null}
      <label>Credential Model<input value={credentialForm.model} aria-invalid={Boolean(credentialErrors.model)} disabled={busy} onChange={(event) => {
        const model = event.target.value;
        setCredentialForm((current) => ({ ...current, model }));
        setQuotaForm((current) => ({ ...current, model }));
      }} placeholder="例如 gemini-3.5-flash-lite" />{credentialFieldError("model")}</label>
      <label>狀態<select value={credentialForm.status} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, status: event.target.value as CredentialStatus }))}><option value="active">Active</option><option value="standby">Standby</option><option value="disabled">Disabled</option></select></label>
      <label>Priority<input type="number" min={0} max={10000} aria-invalid={Boolean(credentialErrors.priority)} value={credentialForm.priority} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, priority: Number(event.target.value) }))} />{credentialFieldError("priority")}</label>
      <label>Weight<input type="number" min={1} max={20} aria-invalid={Boolean(credentialErrors.weight)} value={credentialForm.weight} disabled={busy} onChange={(event) => setCredentialForm((current) => ({ ...current, weight: Number(event.target.value) }))} />{credentialFieldError("weight")}</label>
    </div>
    <div className="admin-action-row">
      <button type="button" className="admin-btn" onClick={onSave} disabled={busy}>{busy ? "處理中…" : editingCredentialId ? "儲存 Credential" : "加密新增 Credential"}</button>
      {editingCredentialId ? <button type="button" className="admin-btn secondary" onClick={onReset} disabled={busy}>取消編輯</button> : null}
    </div>
    <div className="admin-subsection">
      <h3>{editingCredentialId ? "預設模型與配額" : "首次模型與配額"}</h3>
      <p className="admin-help">RPM、TPM、RPD 留白代表未設定／未知。首次模型會與 Credential 儲存同一交易並建立在模型配額列表，且必須是預設模型；之後可在列表新增多個 Model。</p>
      <div className="admin-form-grid">
        <label>Model<input value={quotaForm.model} disabled={busy} placeholder="例如 gemini-3.5-flash-lite" onChange={(event) => {
          const model = event.target.value;
          setQuotaForm((current) => ({ ...current, model }));
        }} /></label>
        <label>RPM 上限<input type="number" min={1} step={1} value={quotaForm.rpmLimit} disabled={busy} placeholder="留白＝未設定" onChange={(event) => setQuotaForm((current) => ({ ...current, rpmLimit: event.target.value }))} /></label>
        <label>TPM 上限<input type="number" min={1} step={1} value={quotaForm.tpmLimit} disabled={busy} placeholder="留白＝未設定" onChange={(event) => setQuotaForm((current) => ({ ...current, tpmLimit: event.target.value }))} /></label>
        <label>RPD 上限<input type="number" min={1} step={1} value={quotaForm.rpdLimit} disabled={busy} placeholder="留白＝未設定" onChange={(event) => setQuotaForm((current) => ({ ...current, rpdLimit: event.target.value }))} /></label>
        <label>每日重置時區<input value={quotaForm.resetTimezone} disabled={busy} placeholder="Asia/Taipei" onChange={(event) => setQuotaForm((current) => ({ ...current, resetTimezone: event.target.value }))} /></label>
        <label className="admin-check-row"><input type="checkbox" checked={quotaForm.enabled} disabled={busy || quotaForm.isDefault} onChange={(event) => setQuotaForm((current) => ({ ...current, enabled: event.target.checked }))} /> 配額啟用</label>
        <label className="admin-check-row"><input type="checkbox" checked={quotaForm.isDefault} disabled={busy || quotaForm.isDefault} onChange={(event) => setQuotaForm((current) => ({ ...current, isDefault: event.target.checked }))} /> 設為預設模型</label>
        <label>貨幣（ISO 4217）<input value={quotaForm.currency} disabled={busy} placeholder="USD" onChange={(event) => setQuotaForm((current) => ({ ...current, currency: event.target.value }))} /></label>
        <label>計價層級<select value={quotaForm.serviceTier || "standard"} disabled={busy} onChange={(event) => setQuotaForm((current) => ({ ...current, serviceTier: event.target.value }))}>
          <option value="standard">Standard（付費）</option>
          <option value="free">Free（免費）</option>
          <option value="unavailable">Unavailable（不提供）</option>
        </select></label>
        <label>Input $/M tokens<input type="number" min={0} step={0.01} value={quotaForm.inputPriceUsdPerMillion} disabled={busy} placeholder="例如 1.5" onChange={(event) => setQuotaForm((current) => ({ ...current, inputPriceUsdPerMillion: event.target.value }))} /></label>
        <label>Output $/M tokens<input type="number" min={0} step={0.01} value={quotaForm.outputPriceUsdPerMillion} disabled={busy} placeholder="例如 7.5" onChange={(event) => setQuotaForm((current) => ({ ...current, outputPriceUsdPerMillion: event.target.value }))} /></label>
        <label>Cached input $/M tokens<input type="number" min={0} step={0.01} value={quotaForm.cachedInputPriceUsdPerMillion} disabled={busy} placeholder="例如 0.15" onChange={(event) => setQuotaForm((current) => ({ ...current, cachedInputPriceUsdPerMillion: event.target.value }))} /></label>
        <label>Cache storage $/M tokens/hr<input type="number" min={0} step={0.01} value={quotaForm.cacheStorageUsdPerMillionTokenHour} disabled={busy} placeholder="例如 1.0" onChange={(event) => setQuotaForm((current) => ({ ...current, cacheStorageUsdPerMillionTokenHour: event.target.value }))} /></label>
        <label>價格生效時間<input value={quotaForm.pricingEffectiveAt} disabled={busy} placeholder="2026-07-01" onChange={(event) => setQuotaForm((current) => ({ ...current, pricingEffectiveAt: event.target.value }))} /></label>
        <label>價格來源<input value={quotaForm.pricingSource} disabled={busy} placeholder="例如 google-ai-studio-2026-07" onChange={(event) => setQuotaForm((current) => ({ ...current, pricingSource: event.target.value }))} /></label>
        <label className="admin-check-row"><input type="checkbox" checked={quotaForm.pricingUnavailable} disabled={busy} onChange={(event) => setQuotaForm((current) => ({ ...current, pricingUnavailable: event.target.checked }))} /> 不提供付費價格</label>
      </div>
      <div className="admin-action-row">
        {editingCredentialId ? <button type="button" className="admin-btn" onClick={onSaveQuota} disabled={busy}>{editingQuotaId ? "儲存模型配額" : "新增模型配額"}</button> : <span className="admin-help">儲存 Credential 後會自動建立首次模型配額。</span>}
        {editingCredentialId ? <button type="button" className="admin-btn secondary" onClick={() => { setEditingQuotaId(null); setQuotaForm({ ...EMPTY_QUOTA, isDefault: false }); }} disabled={busy}>新增其他模型</button> : null}
        {editingQuotaId ? <button type="button" className="admin-btn secondary" onClick={() => { setEditingQuotaId(null); setQuotaForm({ ...EMPTY_QUOTA, isDefault: false }); }} disabled={busy}>取消編輯</button> : null}
      </div>
    </div>
  </>;
}
