import type { Dispatch, SetStateAction } from "react";
import { adminApi } from "../../api";
import { credentialErrorMessage } from "../../credentialErrorMessage";
import {
  EMPTY_QUOTA,
  floatOrNull,
  numberOrNull,
  type ConfirmAction,
  type Credential,
  type ModelQuota,
  type Provider,
  type QuotaForm
} from "./types";
import type { AdminStatus } from "./useAdminStatus";

export type QuotaActions = {
  editQuota: (credential: Credential, quota: ModelQuota) => void;
  saveQuota: () => Promise<void>;
  deleteQuota: (quota: ModelQuota) => Promise<void>;
  toggleQuota: (quota: ModelQuota) => Promise<void>;
  setDefaultQuota: (quota: ModelQuota) => Promise<void>;
};

export type QuotaSectionInput = {
  status: AdminStatus;
  selectedProvider: Provider | null;
  credentials: Credential[];
  editingCredentialId: string | null;
  quotaForm: QuotaForm;
  setQuotaForm: Dispatch<SetStateAction<QuotaForm>>;
  editingQuotaId: string | null;
  setEditingQuotaId: Dispatch<SetStateAction<string | null>>;
  loadCredentials: (providerId: string) => Promise<void>;
  editCredential: (credential: Credential) => void;
  confirmAction: ConfirmAction;
};

/** Model quota mutations for the credential currently being edited. */
export function useQuotaActions({
  status,
  selectedProvider,
  credentials,
  editingCredentialId,
  quotaForm,
  setQuotaForm,
  editingQuotaId,
  setEditingQuotaId,
  loadCredentials,
  editCredential,
  confirmAction
}: QuotaSectionInput): QuotaActions {
  const { setError, setMessage, setBusy } = status;

  function editQuota(credential: Credential, quota: ModelQuota) {
    editCredential(credential);
    setEditingQuotaId(quota.id);
    setQuotaForm({
      model: quota.model,
      rpmLimit: quota.rpmLimit === null ? "" : String(quota.rpmLimit),
      tpmLimit: quota.tpmLimit === null ? "" : String(quota.tpmLimit),
      rpdLimit: quota.rpdLimit === null ? "" : String(quota.rpdLimit),
      resetTimezone: quota.resetTimezone,
      enabled: quota.enabled,
      isDefault: quota.isDefault,
      currency: quota.currency ?? "",
      serviceTier: quota.serviceTier ?? "",
      inputPriceUsdPerMillion: quota.inputPriceUsdPerMillion === null ? "" : String(quota.inputPriceUsdPerMillion),
      outputPriceUsdPerMillion: quota.outputPriceUsdPerMillion === null ? "" : String(quota.outputPriceUsdPerMillion),
      cachedInputPriceUsdPerMillion: quota.cachedInputPriceUsdPerMillion === null ? "" : String(quota.cachedInputPriceUsdPerMillion),
      cacheStorageUsdPerMillionTokenHour: quota.cacheStorageUsdPerMillionTokenHour === null ? "" : String(quota.cacheStorageUsdPerMillionTokenHour),
      pricingEffectiveAt: quota.pricingEffectiveAt ?? "",
      pricingSource: quota.pricingSource ?? "",
      pricingUnavailable: quota.pricingUnavailable ?? false
    });
  }

  async function saveQuota() {
    if (!editingCredentialId) {
      setError("請先儲存 Credential，再新增模型配額。");
      return;
    }
    if (!quotaForm.model.trim()) {
      setError("Model 名稱不可空白。");
      return;
    }
    const limits = [quotaForm.rpmLimit, quotaForm.tpmLimit, quotaForm.rpdLimit];
    if (limits.some((value) => value.trim() && (!/^\d+$/.test(value.trim()) || Number(value) <= 0))) {
      setError("RPM、TPM、RPD 必須是正整數；留白代表未設定。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        model: quotaForm.model.trim(),
        rpmLimit: numberOrNull(quotaForm.rpmLimit),
        tpmLimit: numberOrNull(quotaForm.tpmLimit),
        rpdLimit: numberOrNull(quotaForm.rpdLimit),
        resetTimezone: quotaForm.resetTimezone.trim() || "Asia/Taipei",
        enabled: quotaForm.enabled,
        isDefault: quotaForm.isDefault,
        currency: quotaForm.currency.trim() || null,
        serviceTier: quotaForm.serviceTier.trim() || null,
        inputPriceUsdPerMillion: floatOrNull(quotaForm.inputPriceUsdPerMillion),
        outputPriceUsdPerMillion: floatOrNull(quotaForm.outputPriceUsdPerMillion),
        cachedInputPriceUsdPerMillion: floatOrNull(quotaForm.cachedInputPriceUsdPerMillion),
        cacheStorageUsdPerMillionTokenHour: floatOrNull(quotaForm.cacheStorageUsdPerMillionTokenHour),
        pricingEffectiveAt: quotaForm.pricingEffectiveAt.trim() || null,
        pricingSource: quotaForm.pricingSource.trim() || null,
        pricingUnavailable: quotaForm.pricingUnavailable
      };
      if (editingQuotaId) await adminApi.updateAiCredentialQuota(editingQuotaId, payload);
      else {
        const existing = credentials.find((credential) => credential.id === editingCredentialId)?.modelQuotas
          .find((quota) => quota.model.toLocaleLowerCase() === payload.model.toLocaleLowerCase());
        if (existing) await adminApi.updateAiCredentialQuota(existing.id, payload);
        else await adminApi.createAiCredentialQuota(editingCredentialId, payload);
      }
      setEditingQuotaId(null);
      setQuotaForm({ ...EMPTY_QUOTA, isDefault: false });
      await loadCredentials(selectedProvider!.id);
      setMessage("模型配額已儲存；用量由系統即時估算並顯示重置時間。");
    } catch (quotaError) {
      setError(credentialErrorMessage(quotaError, "save"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteQuota(quota: ModelQuota) {
    if (quota.isDefault) {
      setError("預設模型不可直接刪除，請先指定其他預設模型。");
      return;
    }
    const confirmed = await confirmAction({
      title: "確認刪除模型配額",
      message: `確定刪除 ${quota.model} 的模型配額？刪除後該模型不再受此配額限制。`,
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.deleteAiCredentialQuota(quota.id);
      await loadCredentials(selectedProvider!.id);
      if (editingQuotaId === quota.id) {
        setEditingQuotaId(null);
        setQuotaForm(EMPTY_QUOTA);
      }
      setMessage("模型配額已刪除。");
    } catch (quotaError) {
      setError(credentialErrorMessage(quotaError, "delete"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleQuota(quota: ModelQuota) {
    if (quota.isDefault && quota.enabled) {
      setError("預設模型不可直接停用，請先指定其他預設模型。");
      return;
    }
    const action = quota.enabled ? "停用" : "啟用";
    const confirmed = await confirmAction({
      title: `確認${action}模型配額`,
      message: `確定要${action} ${quota.model} 的模型配額？`,
      tone: action === "停用" ? "danger" : "default"
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.updateAiCredentialQuota(quota.id, { enabled: !quota.enabled });
      if (selectedProvider) await loadCredentials(selectedProvider.id);
      if (editingQuotaId === quota.id) {
        setEditingQuotaId(null);
        setQuotaForm(EMPTY_QUOTA);
      }
      setMessage(`模型配額已${action}；Gateway 將立即${action === "停用" ? "不再使用" : "恢復使用"}此配額。`);
    } catch (quotaError) {
      setError(credentialErrorMessage(quotaError, "save"));
    } finally {
      setBusy(false);
    }
  }

  async function setDefaultQuota(quota: ModelQuota) {
    if (quota.isDefault) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.setDefaultAiCredentialQuota(quota.id);
      if (selectedProvider) await loadCredentials(selectedProvider.id);
      setMessage(`${quota.model} 已設為預設模型，原預設模型已自動取消。`);
    } catch (quotaError) {
      setError(credentialErrorMessage(quotaError, "save"));
    } finally {
      setBusy(false);
    }
  }

  return { editQuota, saveQuota, deleteQuota, toggleQuota, setDefaultQuota };
}
