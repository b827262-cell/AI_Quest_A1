import { priceFor, type AiProviderId } from "@ai-smartbook/ai/browser";
import { quotaMetric, quotaStatus, usageSourceLabel, SYSTEM_DAILY_RESET_LABEL } from "../aiQuotaDisplay";
import { formatDate, formatPriceCol, resetCountdown, resetTime } from "./format";
import type { Credential, ModelQuota } from "./types";

export function QuotaDetailsRow({
  credential,
  providerId,
  now,
  busy,
  onStartNewQuota,
  onRefreshQuotas,
  onEditQuota,
  onSetDefaultQuota,
  onToggleQuota,
  onDeleteQuota
}: {
  credential: Credential;
  providerId: AiProviderId;
  now: number;
  busy: boolean;
  onStartNewQuota: (credential: Credential) => void;
  onRefreshQuotas: (credentialId: string) => void;
  onEditQuota: (credential: Credential, quota: ModelQuota) => void;
  onSetDefaultQuota: (quota: ModelQuota) => void;
  onToggleQuota: (quota: ModelQuota) => void;
  onDeleteQuota: (quota: ModelQuota) => void;
}) {
  const quotas = credential.modelQuotas ?? [];
  return <tr className="admin-quota-detail-row">
    <td colSpan={6}>
      <div className="admin-quota-list">
        <div className="admin-quota-list-header">
          <div>
            <strong>模型配額列表（維度 2：Provider／金鑰／模型的 RPM、TPM、RPD）</strong>
            <span className="muted">（後端 API 用量資料）</span>
          </div>
          <div className="admin-action-row admin-action-row-tight">
            <button type="button" className="admin-btn secondary" onClick={() => onStartNewQuota(credential)} disabled={busy}>＋新增模型配額</button>
            <button type="button" className="admin-btn secondary" onClick={() => void onRefreshQuotas(credential.id)} disabled={busy}>重新整理</button>
          </div>
        </div>
        {quotas.length === 0 ? <p className="muted">尚未設定模型配額；未設定的 Model 視為額度未知，不會被本地配額阻擋。</p> : <div className="admin-table-wrap">
          <p className="muted admin-quota-note">
            下列 RPM／TPM／RPD 與每日重置為<span className="admin-quota-system-label">{SYSTEM_DAILY_RESET_LABEL}</span>（本系統計數策略），並非 Provider 官方帳戶配額。Provider 官方配額（如 Gemini RPD）依 Cloud Project 聚合計算，不因單一 API Key 而獨立。
          </p>
          <p className="muted admin-quota-note">
            Token 使用量與 Provider 方案 Credits 分開顯示；Credits 未取得官方觀測值時保持未配置，不以 Token 估算換算。
          </p>
          <table className="admin-table-compact admin-quota-table">
            <thead><tr><th>Model</th><th>狀態</th><th>Input $/M</th><th>Output $/M</th><th>命中 $/M</th><th>RPM</th><th>TPM</th><th>RPD</th><th>用量來源</th><th>分鐘重置時間</th><th>{SYSTEM_DAILY_RESET_LABEL}（系統）</th><th>最後更新時間</th><th>操作</th></tr></thead>
            <tbody>{quotas.map((quota) => {
              const status = quotaStatus(quota);
              const rpm = quotaMetric(quota.requestsThisMinute, quota.rpmLimit);
              const tpm = quotaMetric(quota.tokensThisMinute, quota.tpmLimit);
              const rpd = quotaMetric(quota.requestsToday, quota.rpdLimit);
              return <tr key={quota.id}>
                <td><strong>{quota.model}</strong>{quota.isDefault ? <span className="admin-quota-default-badge">預設</span> : null}</td>
                <td><span className={status.className}>{status.label}</span></td>
                <td>{formatPriceCol(priceFor(providerId, quota.model), "input")}</td>
                <td>{formatPriceCol(priceFor(providerId, quota.model), "output")}</td>
                <td>{formatPriceCol(priceFor(providerId, quota.model), "cached")}</td>
                <td>{rpm.value}<br /><span className="muted">剩餘 {rpm.remaining}</span></td>
                <td>{tpm.value}<br /><span className="muted">剩餘 {tpm.remaining}</span></td>
                <td>{rpd.value}<br /><span className="muted">剩餘 {rpd.remaining}</span></td>
                <td title={quota.usageSource === "provider_response" ? "Provider 回應中的 token usage；不代表帳戶剩餘額度" : "由本系統 usage log 與請求計數估算"}>{usageSourceLabel(quota.usageSource)}</td>
                <td>{resetTime(quota.minuteResetAt, quota.resetTimezone)}<br /><span className="muted">{resetCountdown(quota.minuteResetAt, now)}</span></td>
                <td>{resetTime(quota.dailyResetAt, quota.resetTimezone)}<br /><span className="muted">{quota.resetTimezone} · {resetCountdown(quota.dailyResetAt, now)}</span></td>
                <td>{formatDate(quota.updatedAt)}</td>
                <td><div className="admin-action-row admin-action-row-tight">
                  <button type="button" className="admin-btn secondary" onClick={() => onEditQuota(credential, quota)} disabled={busy}>編輯</button>
                  <button type="button" className="admin-btn secondary" onClick={() => void onSetDefaultQuota(quota)} disabled={busy || quota.isDefault || !quota.enabled}>{quota.isDefault ? "目前預設" : "設為預設"}</button>
                  <button type="button" className="admin-btn secondary" onClick={() => void onToggleQuota(quota)} disabled={busy || quota.isDefault}>{quota.enabled ? "停用" : "啟用"}</button>
                  <button type="button" className="admin-btn danger" onClick={() => void onDeleteQuota(quota)} disabled={busy || quota.isDefault}>刪除</button>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
      </div>
    </td>
  </tr>;
}
