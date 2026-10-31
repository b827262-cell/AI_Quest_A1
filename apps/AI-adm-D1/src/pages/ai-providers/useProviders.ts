import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { adminApi, ApiHttpError } from "../../api";
import { useConfirm, useNotice } from "../../components/useConfirm";
import { providerErrorMessage } from "../../providerErrorMessage";
import { EMPTY_PROVIDER, type Provider, type ProviderForm } from "./types";
import type { AdminStatus } from "./useAdminStatus";

export type ProviderSection = {
  providers: Provider[];
  selectedProviderId: string | null;
  selectedProvider: Provider | null;
  providerForm: ProviderForm;
  setProviderForm: Dispatch<SetStateAction<ProviderForm>>;
  setSelectedProviderId: Dispatch<SetStateAction<string | null>>;
  loading: boolean;
  loadProviders: () => Promise<void>;
  selectProvider: (provider: Provider) => void;
  saveProvider: () => Promise<void>;
  toggleProvider: () => Promise<void>;
  deleteProvider: (provider: Provider) => Promise<void>;
};

/** Provider list, the Provider editor form and the Provider mutations. */
export function useProviders(status: AdminStatus): ProviderSection {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm>(EMPTY_PROVIDER);
  const [loading, setLoading] = useState(true);
  const providerSaveInFlight = useRef(false);
  const confirmAction = useConfirm();
  const notice = useNotice();
  const { setError, setMessage, setBusy } = status;

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;

  async function loadProviders() {
    setLoading(true);
    setError("");
    try {
      const response = await adminApi.listAiProviders();
      const rows = response.providers as Provider[];
      setProviders(rows);
      setSelectedProviderId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
      if (rows.length === 0) setProviderForm(EMPTY_PROVIDER);
    } catch {
      setError("無法讀取 Provider 設定，請確認管理 API 與授權狀態。");
    } finally {
      setLoading(false);
    }
  }

  function selectProvider(provider: Provider) {
    setSelectedProviderId(provider.id);
    setMessage("");
    setError("");
  }

  async function saveProvider() {
    if (providerSaveInFlight.current) return;
    if (!providerForm.displayName.trim()) {
      setError("請填寫 Provider 顯示名稱。");
      return;
    }
    providerSaveInFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        ...(selectedProvider ? { id: selectedProvider.id } : {}),
        provider: providerForm.provider,
        slug: providerForm.slug.trim() || undefined,
        displayName: providerForm.displayName.trim(),
        baseUrl: providerForm.baseUrl.trim() || null,
        model: providerForm.model.trim() || null,
        enabled: providerForm.enabled,
        isDefault: providerForm.isDefault,
        isRouterProvider: providerForm.isRouterProvider,
        priority: Number(providerForm.priority)
      };
      const response = selectedProvider
        ? await adminApi.updateAiProvider(payload)
        : await adminApi.saveAiProvider(payload);
      const saved = response.provider as Provider;
      await loadProviders();
      setSelectedProviderId(saved.id);
      setMessage(response.code === "provider_restored" ? "已恢復先前刪除的 Provider。" : "Provider 設定已儲存。");
    } catch (saveError) {
      setError(providerErrorMessage(saveError));
    } finally {
      providerSaveInFlight.current = false;
      setBusy(false);
    }
  }

  async function toggleProvider() {
    if (!selectedProvider) return;
    const nextEnabled = !selectedProvider.enabled;
    const confirmed = await confirmAction({
      title: nextEnabled ? "確認啟用 Provider" : "確認停用 Provider",
      message: `確定要${nextEnabled ? "啟用" : "停用"} ${selectedProvider.displayName}？`,
      tone: nextEnabled ? "default" : "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.updateAiProvider({ ...providerForm, id: selectedProvider.id, provider: selectedProvider.provider, enabled: nextEnabled });
      await loadProviders();
      setMessage(`Provider 已${nextEnabled ? "啟用" : "停用"}。`);
    } catch {
      setError("Provider 狀態更新失敗。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider(provider: Provider) {
    if (provider.isRouterProvider) {
      await notice({
        title: "無法刪除 Provider",
        message: "此 Provider 是 Default Router，不能直接刪除；請先指定其他 Default Router。\n\n按「確定」關閉提示。"
      });
      setError("此 Provider 是 Default Router，請先指定其他 Default Router 再刪除。");
      return;
    }
    const confirmed = await confirmAction({
      title: "確認刪除 Provider",
      message: `確定要刪除 ${provider.displayName}？\n\n這會停用所屬 Credential 與所有模型配額，Gateway 將立即停止選用。`,
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await adminApi.deleteAiProvider(provider.id);
      await loadProviders();
      setMessage("Provider 已刪除；所屬 Credential 與模型配額已同步停用。Gateway 不需重啟即可生效。");
    } catch (deleteError) {
      if (deleteError instanceof ApiHttpError && deleteError.status === 409) {
        setError("此 Provider 是 Default Router，請先指定其他 Default Router 再刪除。");
      } else {
        setError("Provider 刪除失敗，請稍後再試。第三方錯誤內容已隱去。");
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    providers,
    selectedProviderId,
    selectedProvider,
    providerForm,
    setProviderForm,
    setSelectedProviderId,
    loading,
    loadProviders,
    selectProvider,
    saveProvider,
    toggleProvider,
    deleteProvider
  };
}
