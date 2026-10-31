import { useState, type Dispatch, type SetStateAction } from "react";
import { adminApi } from "../../api";
import {
  credentialErrorMessage,
  credentialFieldErrors,
  credentialFormAfterFailure,
  credentialTestResultMessage
} from "../../credentialErrorMessage";
import {
  EMPTY_CREDENTIAL,
  EMPTY_QUOTA,
  floatOrNull,
  numberOrNull,
  quotaFormFrom,
  type ConfirmAction,
  type Credential,
  type CredentialActionKind,
  type CredentialForm,
  type ModelQuota,
  type Provider,
  type QuotaForm
} from "./types";
import type { AdminStatus } from "./useAdminStatus";

export type CredentialActions = {
  testCredential: (credential: Credential) => Promise<void>;
  editCredential: (credential: Credential) => void;
  credentialAction: (credential: Credential, action: CredentialActionKind) => Promise<void>;
  startNewQuota: (credential: Credential) => void;
  refreshCredentialQuotas: (credentialId: string) => Promise<void>;
};

export type CredentialSection = CredentialActions & {
  credentials: Credential[];
  setCredentials: Dispatch<SetStateAction<Credential[]>>;
  credentialForm: CredentialForm;
  setCredentialForm: Dispatch<SetStateAction<CredentialForm>>;
  editingCredentialId: string | null;
  setEditingCredentialId: Dispatch<SetStateAction<string | null>>;
  credentialErrors: Record<string, string>;
  credentialsLoading: boolean;
  loadCredentials: (providerId: string) => Promise<void>;
  saveCredential: () => Promise<void>;
  resetCredentialForm: () => void;
};

export type CredentialSectionInput = {
  status: AdminStatus;
  selectedProvider: Provider | null;
  quotaForm: QuotaForm;
  setQuotaForm: Dispatch<SetStateAction<QuotaForm>>;
  setEditingQuotaId: Dispatch<SetStateAction<string | null>>;
  confirmAction: ConfirmAction;
};

/** Credential list, credential editor form and the credential mutations. */
export function useCredentials({
  status,
  selectedProvider,
  quotaForm,
  setQuotaForm,
  setEditingQuotaId,
  confirmAction
}: CredentialSectionInput): CredentialSection {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(EMPTY_CREDENTIAL);
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  const [credentialErrors, setCredentialErrors] = useState<Record<string, string>>({});
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const { setError, setMessage, setBusy } = status;

  async function loadCredentials(providerId: string) {
    setCredentialsLoading(true);
    setError("");
    try {
      const response = await adminApi.listAiCredentials(providerId);
      setCredentials(response.credentials as Credential[]);
    } catch {
      setCredentials([]);
      setError("無法讀取 Credential 清單。");
    } finally {
      setCredentialsLoading(false);
    }
  }

  async function refreshCredentialQuotas(credentialId: string) {
    if (!selectedProvider) return;
    setBusy(true);
    setError("");
    try {
      const response = await adminApi.listAiCredentialQuotas(credentialId);
      const quotas = response.quotas as ModelQuota[];
      setCredentials((current) => current.map((credential) => credential.id === credentialId
        ? { ...credential, modelQuotas: quotas }
        : credential));
      setMessage("模型配額用量已重新取得。來源與重置時間均以後端資料為準。");
    } catch {
      setError("無法重新取得模型配額列表，請稍後再試。第三方錯誤內容已隱去。");
    } finally {
      setBusy(false);
    }
  }

  function editCredential(credential: Credential) {
    setEditingCredentialId(credential.id);
    setCredentialForm({
      name: credential.name,
      apiKey: "",
      baseUrl: credential.baseUrl ?? "",
      model: credential.model ?? credential.modelQuotas.find((quota) => quota.isDefault)?.model ?? "",
      endpointProfile: credential.endpointProfile ?? "",
      status: credential.status,
      priority: credential.priority,
      weight: credential.weight
    });
    setEditingQuotaId(null);
    const defaultQuota = credential.modelQuotas.find((quota) => quota.isDefault) ?? credential.modelQuotas[0];
    setQuotaForm(defaultQuota ? quotaFormFrom(defaultQuota, true) : { ...EMPTY_QUOTA, model: credential.model ?? "" });
    setMessage("編輯模式：API Key 留白即可保留原 Key。");
  }

  function startNewQuota(credential: Credential) {
    editCredential(credential);
    setEditingQuotaId(null);
    setQuotaForm({ ...EMPTY_QUOTA, isDefault: false });
    setCredentialErrors({});
    setError("");
    setMessage(`已選取 ${credential.name}，請新增模型配額。`);
  }

  function resetCredentialForm() {
    setEditingCredentialId(null);
    setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
    setCredentialErrors({});
    setMessage("");
  }

  async function saveCredential() {
    if (!selectedProvider || !credentialForm.name.trim()) {
      setCredentialErrors({ name: "Credential 名稱為必填欄位。" });
      setError("請填寫 Credential 名稱。");
      return;
    }
    if (!editingCredentialId && !credentialForm.apiKey.trim()) {
      setCredentialErrors({ apiKey: "新增 Credential 必須輸入 API Key。" });
      setError("新增 Credential 必須輸入 API Key。");
      return;
    }
    const limits = [quotaForm.rpmLimit, quotaForm.tpmLimit, quotaForm.rpdLimit];
    if (limits.some((value) => value.trim() && (!/^\d+$/.test(value.trim()) || Number(value) <= 0))) {
      setCredentialErrors({ rpmLimit: "RPM、TPM、RPD 必須是正整數；留白代表未設定。" });
      setError("RPM、TPM、RPD 必須是正整數；留白代表未設定。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    setCredentialErrors({});
    try {
      const initialModel = credentialForm.model.trim() || quotaForm.model.trim() || null;
      const payload: Record<string, unknown> = {
        name: credentialForm.name.trim(),
        baseUrl: credentialForm.baseUrl.trim() || null,
        model: initialModel,
        endpointProfile: credentialForm.endpointProfile.trim() || null,
        status: credentialForm.status,
        priority: Number(credentialForm.priority),
        weight: Number(credentialForm.weight)
      };
      if (initialModel) {
        payload.rpmLimit = numberOrNull(quotaForm.rpmLimit);
        payload.tpmLimit = numberOrNull(quotaForm.tpmLimit);
        payload.rpdLimit = numberOrNull(quotaForm.rpdLimit);
        payload.resetTimezone = quotaForm.resetTimezone.trim() || "Asia/Taipei";
        payload.isDefaultModel = quotaForm.isDefault;
        payload.currency = quotaForm.currency.trim() || null;
        payload.serviceTier = quotaForm.serviceTier.trim() || null;
        payload.inputPriceUsdPerMillion = floatOrNull(quotaForm.inputPriceUsdPerMillion);
        payload.outputPriceUsdPerMillion = floatOrNull(quotaForm.outputPriceUsdPerMillion);
        payload.cachedInputPriceUsdPerMillion = floatOrNull(quotaForm.cachedInputPriceUsdPerMillion);
        payload.cacheStorageUsdPerMillionTokenHour = floatOrNull(quotaForm.cacheStorageUsdPerMillionTokenHour);
        payload.pricingEffectiveAt = quotaForm.pricingEffectiveAt.trim() || null;
        payload.pricingSource = quotaForm.pricingSource.trim() || null;
        payload.pricingUnavailable = quotaForm.pricingUnavailable;
      }
      if (credentialForm.apiKey.trim()) payload.apiKey = credentialForm.apiKey;
      if (editingCredentialId) {
        await adminApi.updateAiCredential(editingCredentialId, payload);
        setMessage("Credential 安全 metadata 已更新；未輸入新 Key，因此原 Key 保留。");
      } else {
        await adminApi.createAiCredential(selectedProvider.id, { ...payload, apiKey: credentialForm.apiKey });
        setMessage("Credential 已加密儲存；完整 Key 不會再次顯示。");
      }
      resetCredentialForm();
      await loadCredentials(selectedProvider.id);
    } catch (saveError) {
      const fieldErrors = credentialFieldErrors(saveError);
      setCredentialErrors(fieldErrors);
      // Only prompt to re-enter the API Key when the key itself was the
      // problem (missing/invalid/masked). A validation error on an unrelated
      // field (e.g. endpointProfile) must not blame the key or clear it.
      const apiKeyIsCulprit = "apiKey" in fieldErrors;
      if (!editingCredentialId && credentialForm.apiKey.trim() && apiKeyIsCulprit) {
        setCredentialForm((current) => credentialFormAfterFailure(current, true));
        setError("新增失敗，請重新輸入 API Key。\n" + credentialErrorMessage(saveError, "save"));
      } else {
        setError(credentialErrorMessage(saveError, "save"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function credentialAction(credential: Credential, action: CredentialActionKind) {
    const deletingLastActive = action === "delete" && credential.status === "active"
      && credentials.filter((row) => row.status === "active").length === 1;
    if (action === "delete") {
      const confirmed = await confirmAction({
        title: "確認刪除 Credential",
        message: `確定要軟刪除 ${credential.name}？刪除後不可再被 Gateway 選用。${deletingLastActive ? "\n警告：這是此 Provider 最後一組 Active Key。" : ""}`,
        tone: "danger"
      });
      if (!confirmed) return;
    }
    if (action === "disable") {
      const confirmed = await confirmAction({
        title: "確認停用 Credential",
        message: `確定要停用 ${credential.name}？`,
        tone: "danger"
      });
      if (!confirmed) return;
    }
    if (!selectedProvider) return;
    setBusy(true);
    setError("");
    try {
      if (action === "enable") await adminApi.enableAiCredential(credential.id);
      if (action === "disable") await adminApi.disableAiCredential(credential.id);
      if (action === "delete") await adminApi.deleteAiCredential(credential.id);
      await loadCredentials(selectedProvider.id);
      setMessage(action === "delete" ? "Credential 已軟刪除。" : `Credential 已${action === "enable" ? "啟用" : "停用"}。`);
    } catch (actionError) {
      setError(credentialErrorMessage(actionError, "delete"));
    } finally {
      setBusy(false);
    }
  }

  async function testCredential(credential: Credential) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await adminApi.testAiCredential(credential.id);
      const isSuccess = response.status === "success";
      const detailMsg = credentialTestResultMessage(response);
      if (isSuccess) {
        setMessage(detailMsg);
      } else {
        setError(detailMsg);
      }
      if (selectedProvider) await loadCredentials(selectedProvider.id);
    } catch (testError) {
      setError(credentialErrorMessage(testError, "test"));
      if (selectedProvider) await loadCredentials(selectedProvider.id);
    } finally {
      setBusy(false);
    }
  }

  return {
    credentials,
    setCredentials,
    credentialForm,
    setCredentialForm,
    editingCredentialId,
    setEditingCredentialId,
    credentialErrors,
    credentialsLoading,
    loadCredentials,
    refreshCredentialQuotas,
    editCredential,
    startNewQuota,
    resetCredentialForm,
    saveCredential,
    credentialAction,
    testCredential
  };
}
