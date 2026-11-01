import { Fragment } from "react";
import type { AiProviderId } from "@ai-smartbook/ai/browser";
import { formatDate, statusLabel } from "./format";
import { QuotaDetailsRow } from "./QuotaDetailsRow";
import type { CredentialActions } from "./useCredentials";
import type { QuotaActions } from "./useQuotaActions";
import type { Credential } from "./types";

export function CredentialTable({
  credentials,
  credentialsLoading,
  busy,
  now,
  providerId,
  credentialActions,
  quotaActions
}: {
  credentials: Credential[];
  credentialsLoading: boolean;
  busy: boolean;
  now: number;
  providerId: AiProviderId;
  credentialActions: CredentialActions;
  quotaActions: QuotaActions;
}) {
  return credentialsLoading ? <p role="status">Credential 載入中…</p> : credentials.length === 0 ? <p className="muted">此 Provider 尚無 Credential。</p> : <div className="admin-table-wrap">
    <table className="admin-table-compact">
      <thead><tr><th>名稱／遮罩</th><th>狀態</th><th>Priority／Weight</th><th>Failure／Cooldown</th><th>最後測試</th><th>操作</th></tr></thead>
      <tbody>{credentials.map((credential) => <Fragment key={credential.id}>
        <tr>
          <td><strong>{credential.name}</strong><br /><code className="admin-safe-mask">{credential.maskedApiKey}</code></td>
          <td>{statusLabel(credential.status)}</td>
          <td>{credential.priority} / {credential.weight}</td>
          <td>{credential.failureCount}<br /><span className="muted">{credential.cooldownUntil ? `至 ${formatDate(credential.cooldownUntil)}` : "無 cooldown"}</span></td>
          <td>{credential.lastTestStatus ? `${credential.lastTestStatus}${credential.lastTestLatencyMs ? ` · ${credential.lastTestLatencyMs} ms` : ""}` : "未測試"}<br /><span className="muted">{formatDate(credential.lastTestedAt)}</span></td>
          <td><div className="admin-action-row admin-action-row-tight">
            <button type="button" className="admin-btn secondary" onClick={() => void credentialActions.testCredential(credential)} disabled={busy || credential.status === "disabled"}>測試</button>
            <button type="button" className="admin-btn secondary" onClick={() => credentialActions.editCredential(credential)} disabled={busy}>編輯</button>
            {credential.status === "disabled" ? <button type="button" className="admin-btn secondary" onClick={() => void credentialActions.credentialAction(credential, "enable")} disabled={busy}>啟用</button> : <button type="button" className="admin-btn secondary" onClick={() => void credentialActions.credentialAction(credential, "disable")} disabled={busy}>停用</button>}
            <button type="button" className="admin-btn danger" onClick={() => void credentialActions.credentialAction(credential, "delete")} disabled={busy}>刪除（軟刪除）</button>
          </div></td>
        </tr>
        <QuotaDetailsRow
          credential={credential}
          providerId={providerId}
          now={now}
          busy={busy}
          onStartNewQuota={credentialActions.startNewQuota}
          onRefreshQuotas={credentialActions.refreshCredentialQuotas}
          onEditQuota={quotaActions.editQuota}
          onSetDefaultQuota={quotaActions.setDefaultQuota}
          onToggleQuota={quotaActions.toggleQuota}
          onDeleteQuota={quotaActions.deleteQuota}
        />
      </Fragment>)}</tbody>
    </table>
  </div>;
}
