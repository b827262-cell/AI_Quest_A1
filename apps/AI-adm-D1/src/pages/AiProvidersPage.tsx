import { useEffect, useState } from "react";
import type { AiProviderId } from "@ai-smartbook/ai/browser";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { CredentialFormCard } from "./ai-providers/CredentialFormCard";
import { CredentialTable } from "./ai-providers/CredentialTable";
import { ProviderFormCard } from "./ai-providers/ProviderFormCard";
import { ProviderListCard } from "./ai-providers/ProviderListCard";
import {
  EMPTY_CREDENTIAL,
  EMPTY_PROVIDER,
  EMPTY_QUOTA,
  providerFormFrom,
  type QuotaForm
} from "./ai-providers/types";
import { useAdminStatus } from "./ai-providers/useAdminStatus";
import { useCredentials } from "./ai-providers/useCredentials";
import { useProviders } from "./ai-providers/useProviders";
import { useQuotaActions } from "./ai-providers/useQuotaActions";

export function AiProvidersPage() {
  const status = useAdminStatus();
  const providers = useProviders(status);
  const [quotaForm, setQuotaForm] = useState<QuotaForm>(EMPTY_QUOTA);
  const [editingQuotaId, setEditingQuotaId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const credentials = useCredentials({
    status,
    selectedProvider: providers.selectedProvider,
    quotaForm,
    setQuotaForm,
    setEditingQuotaId
  });
  const quotaActions = useQuotaActions({
    status,
    selectedProvider: providers.selectedProvider,
    credentials: credentials.credentials,
    editingCredentialId: credentials.editingCredentialId,
    quotaForm,
    setQuotaForm,
    editingQuotaId,
    setEditingQuotaId,
    loadCredentials: credentials.loadCredentials,
    editCredential: credentials.editCredential
  });

  // Effect 1 (原版 L333)：掛載時載入 Provider 清單。
  useEffect(() => {
    void providers.loadProviders();
  }, []);

  // Effect 2 (原版 L337)：Provider 選取變更時同步表單並載入 Credential。
  useEffect(() => {
    if (!providers.selectedProvider) {
      credentials.setCredentials([]);
      providers.setProviderForm(EMPTY_PROVIDER);
      return;
    }
    providers.setProviderForm(providerFormFrom(providers.selectedProvider));
    credentials.setEditingCredentialId(null);
    credentials.setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
    void credentials.loadCredentials(providers.selectedProvider.id);
  }, [providers.selectedProviderId, providers.providers]);

  // Effect 3 (原版 L652)：每秒更新配額重置倒數。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  function startNewProvider() {
    providers.setSelectedProviderId(null);
    providers.setProviderForm(EMPTY_PROVIDER);
    credentials.setCredentials([]);
    credentials.setEditingCredentialId(null);
    credentials.setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
    status.setMessage("");
    status.setError("");
  }

  if (providers.loading) return <p role="status">Provider 設定載入中…</p>;
  if (status.error && providers.providers.length === 0 && !providers.selectedProviderId) {
    return <AdminErrorCard title="Provider 設定無法載入" description={status.error} onRetry={() => void providers.loadProviders()} />;
  }

  return <div>
    <AdminPageHeader
      title="AI Provider 與 Credential"
      subtitle="API Key 僅在伺服器端加密保存；前端只會收到遮罩值與安全狀態 metadata。"
      actions={<button type="button" className="admin-btn" onClick={startNewProvider} disabled={status.busy}>新增 Provider</button>}
    />
    {status.message ? <p className="admin-inline-success" role="status">{status.message}</p> : null}
    {status.error ? <p className="admin-inline-error" role="alert">{status.error}</p> : null}

    <ProviderListCard
      providers={providers.providers}
      busy={status.busy}
      onSelect={providers.selectProvider}
      onDelete={providers.deleteProvider}
    />

    <ProviderFormCard
      selectedProvider={providers.selectedProvider}
      providerForm={providers.providerForm}
      setProviderForm={providers.setProviderForm}
      busy={status.busy}
      onSave={() => void providers.saveProvider()}
      onToggle={() => void providers.toggleProvider()}
    />

    {providers.selectedProvider ? <AdminCard title={`${providers.selectedProvider.displayName} 的 Credential`}>
      <CredentialFormCard
        selectedProvider={providers.selectedProvider}
        credentialForm={credentials.credentialForm}
        setCredentialForm={credentials.setCredentialForm}
        quotaForm={quotaForm}
        setQuotaForm={setQuotaForm}
        editingCredentialId={credentials.editingCredentialId}
        editingQuotaId={editingQuotaId}
        setEditingQuotaId={setEditingQuotaId}
        credentialErrors={credentials.credentialErrors}
        busy={status.busy}
        onSave={() => void credentials.saveCredential()}
        onReset={credentials.resetCredentialForm}
        onSaveQuota={() => void quotaActions.saveQuota()}
      />
      <CredentialTable
        credentials={credentials.credentials}
        credentialsLoading={credentials.credentialsLoading}
        busy={status.busy}
        now={now}
        providerId={providers.selectedProvider.provider as AiProviderId}
        credentialActions={credentials}
        quotaActions={quotaActions}
      />
    </AdminCard> : null}
  </div>;
}
