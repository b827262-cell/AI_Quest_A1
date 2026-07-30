import { Fragment, useEffect, useRef, useState } from "react";
import { adminApi, ApiHttpError } from "../api";
import { priceFor, type AiProviderId } from "@ai-smartbook/ai/browser";
import { AdminCard } from "../components/admin/AdminCard";
import { AdminErrorCard } from "../components/admin/AdminErrorCard";
import { AdminPageHeader } from "../components/admin/AdminPageHeader";
import { quotaMetric, quotaStatus, usageSourceLabel, SYSTEM_DAILY_RESET_LABEL } from "./aiQuotaDisplay";
import { providerErrorMessage } from "../providerErrorMessage";
import { credentialErrorMessage, credentialFieldErrors, credentialFormAfterFailure, credentialTestResultMessage } from "../credentialErrorMessage";

type ProviderId = "openai" | "gemini" | "kimi" | "qwen" | "zai";
type CredentialStatus = "active" | "standby" | "disabled";

type Provider = {
  id: string;
  provider: ProviderId;
  slug: string;
  displayName: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  isDefault: boolean;
  isRouterProvider: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

type Credential = {
  id: string;
  name: string;
  maskedApiKey: string;
  baseUrl: string | null;
  model: string | null;
  status: CredentialStatus;
  priority: number;
  weight: number;
  failureCount: number;
  cooldownUntil: string | null;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestLatencyMs: number | null;
  disabledAt: string | null;
  endpointProfile: string | null;
  modelQuotas: ModelQuota[];
};

type ModelQuota = {
  id: string;
  credentialId: string;
  model: string;
  rpmLimit: number | null;
  tpmLimit: number | null;
  rpdLimit: number | null;
  requestsThisMinute: number;
  tokensThisMinute: number;
  requestsToday: number;
  minuteResetAt: string;
  dailyResetAt: string;
  resetTimezone: string;
  usageSource: "provider_response" | "system_estimated";
  enabled: boolean;
  isDefault: boolean;
  currency: string | null;
  serviceTier: string | null;
  inputPriceUsdPerMillion: number | null;
  outputPriceUsdPerMillion: number | null;
  cachedInputPriceUsdPerMillion: number | null;
  cacheStorageUsdPerMillionTokenHour: number | null;
  pricingEffectiveAt: string | null;
  pricingSource: string | null;
  pricingUnavailable: boolean | null;
  remaining: { rpm: number | null; tpm: number | null; rpd: number | null };
  createdAt: string;
  updatedAt: string;
};

type ProviderForm = {
  provider: ProviderId;
  slug: string;
  displayName: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  isRouterProvider: boolean;
  priority: number;
};

type CredentialForm = {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  endpointProfile: string;
  status: CredentialStatus;
  priority: number;
  weight: number;
};

type QuotaForm = {
  model: string;
  rpmLimit: string;
  tpmLimit: string;
  rpdLimit: string;
  resetTimezone: string;
  enabled: boolean;
  isDefault: boolean;
  currency: string;
  serviceTier: string;
  inputPriceUsdPerMillion: string;
  outputPriceUsdPerMillion: string;
  cachedInputPriceUsdPerMillion: string;
  cacheStorageUsdPerMillionTokenHour: string;
  pricingEffectiveAt: string;
  pricingSource: string;
  pricingUnavailable: boolean;
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "Qwen",
  zai: "Z.AI"
};

const PROVIDER_BASE_URL_DEFAULTS: Partial<Record<ProviderId, string>> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  zai: "https://api.z.ai/api/paas/v4"
};

const PROVIDER_MODEL_DEFAULTS: Partial<Record<ProviderId, string>> = { zai: "glm-5.1" };

const EMPTY_PROVIDER: ProviderForm = {
  provider: "openai",
  slug: "",
  displayName: "OpenAI",
  baseUrl: "",
  model: "",
  enabled: true,
  isDefault: false,
  isRouterProvider: false,
  priority: 100
};

const EMPTY_CREDENTIAL: CredentialForm = {
  name: "",
  apiKey: "",
  baseUrl: "",
  model: "",
  endpointProfile: "",
  status: "active",
  priority: 100,
  weight: 1
};

const EMPTY_QUOTA: QuotaForm = {
  model: "",
  rpmLimit: "",
  tpmLimit: "",
  rpdLimit: "",
  resetTimezone: "Asia/Taipei",
  enabled: true,
  isDefault: true,
  currency: "",
  serviceTier: "",
  inputPriceUsdPerMillion: "",
  outputPriceUsdPerMillion: "",
  cachedInputPriceUsdPerMillion: "",
  cacheStorageUsdPerMillionTokenHour: "",
  pricingEffectiveAt: "",
  pricingSource: "",
  pricingUnavailable: false
};

function providerFormFrom(row: Provider): ProviderForm {
  return {
    provider: row.provider,
    slug: row.slug,
    displayName: row.displayName,
    baseUrl: row.baseUrl ?? "",
    model: row.model ?? "",
    enabled: row.enabled,
    isDefault: row.isDefault,
    isRouterProvider: row.isRouterProvider,
    priority: row.priority
  };
}

function quotaFormFrom(row: ModelQuota, isDefault = row.isDefault): QuotaForm {
  return {
    model: row.model,
    rpmLimit: row.rpmLimit === null ? "" : String(row.rpmLimit),
    tpmLimit: row.tpmLimit === null ? "" : String(row.tpmLimit),
    rpdLimit: row.rpdLimit === null ? "" : String(row.rpdLimit),
    resetTimezone: row.resetTimezone,
    enabled: row.enabled,
    isDefault,
    currency: row.currency ?? "",
    serviceTier: row.serviceTier ?? "",
    inputPriceUsdPerMillion: row.inputPriceUsdPerMillion === null ? "" : String(row.inputPriceUsdPerMillion),
    outputPriceUsdPerMillion: row.outputPriceUsdPerMillion === null ? "" : String(row.outputPriceUsdPerMillion),
    cachedInputPriceUsdPerMillion: row.cachedInputPriceUsdPerMillion === null ? "" : String(row.cachedInputPriceUsdPerMillion),
    cacheStorageUsdPerMillionTokenHour: row.cacheStorageUsdPerMillionTokenHour === null ? "" : String(row.cacheStorageUsdPerMillionTokenHour),
    pricingEffectiveAt: row.pricingEffectiveAt ?? "",
    pricingSource: row.pricingSource ?? "",
    pricingUnavailable: row.pricingUnavailable ?? false
  };
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("zh-TW");
}

function formatPriceCol(
  pricing: ReturnType<typeof priceFor>,
  field: "input" | "output" | "cached"
): string {
  if (pricing.serviceTier === "unavailable") return "未提供";
  if (pricing.serviceTier === "free") return "免費";
  const value =
    field === "input"
      ? pricing.inputPriceUsdPerMillion
      : field === "output"
        ? pricing.outputPriceUsdPerMillion
        : pricing.cachedInputPriceUsdPerMillion;
  return `$${value.toFixed(2)}`;
}

function resetCountdown(value: string, now: number): string {
  const seconds = Math.ceil((new Date(value).getTime() - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "即將重置";
  return `約 ${seconds} 秒後重置`;
}

function numberOrNull(value: string): number | null {
  const normalized = value.trim();
  return normalized ? Number(normalized) : null;
}

function resetTime(value: string, timezone?: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: timezone
    }).format(parsed);
  } catch {
    return formatDate(value);
  }
}

function statusLabel(status: CredentialStatus): string {
  return status === "active" ? "Active" : status === "standby" ? "Standby" : "Disabled";
}

export function AiProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm>(EMPTY_PROVIDER);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>(EMPTY_CREDENTIAL);
  const [quotaForm, setQuotaForm] = useState<QuotaForm>(EMPTY_QUOTA);
  const [editingQuotaId, setEditingQuotaId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [credentialErrors, setCredentialErrors] = useState<Record<string, string>>({});
  const providerSaveInFlight = useRef(false);

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

  useEffect(() => {
    void loadProviders();
  }, []);

  useEffect(() => {
    if (!selectedProvider) {
      setCredentials([]);
      setProviderForm(EMPTY_PROVIDER);
      return;
    }
    setProviderForm(providerFormFrom(selectedProvider));
    setEditingCredentialId(null);
    setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
    void loadCredentials(selectedProvider.id);
  }, [selectedProviderId, providers]);

  function selectProvider(provider: Provider) {
    setSelectedProviderId(provider.id);
    setMessage("");
    setError("");
  }

  function startNewProvider() {
    setSelectedProviderId(null);
    setProviderForm(EMPTY_PROVIDER);
    setCredentials([]);
    setEditingCredentialId(null);
    setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
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
    if (!window.confirm(`確定要${nextEnabled ? "啟用" : "停用"} ${selectedProvider.displayName}？`)) return;
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
      window.confirm("此 Provider 是 Default Router，不能直接刪除；請先指定其他 Default Router。\n\n按「確定」關閉提示。");
      setError("此 Provider 是 Default Router，請先指定其他 Default Router 再刪除。");
      return;
    }
    if (!window.confirm(`確定要刪除 ${provider.displayName}？\n\n這會停用所屬 Credential 與所有模型配額，Gateway 將立即停止選用。`)) return;
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

  function resetCredentialForm() {
    setEditingCredentialId(null);
    setCredentialForm(EMPTY_CREDENTIAL);
    setEditingQuotaId(null);
    setQuotaForm(EMPTY_QUOTA);
    setCredentialErrors({});
    setMessage("");
  }

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

  function floatOrNull(value: string): number | null {
    const trimmed = value.trim();
    return trimmed ? Number(trimmed) : null;
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
    if (!window.confirm(`確定刪除 ${quota.model} 的模型配額？刪除後該模型不再受此配額限制。`)) return;
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
    if (!window.confirm(`確定要${action} ${quota.model} 的模型配額？`)) return;
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
      setCredentialErrors(credentialFieldErrors(saveError));
      if (!editingCredentialId && credentialForm.apiKey.trim()) {
        setCredentialForm((current) => credentialFormAfterFailure(current, true));
        setError("新增失敗，請重新輸入 API Key。\n" + credentialErrorMessage(saveError, "save"));
      } else {
        setError(credentialErrorMessage(saveError, "save"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function credentialAction(credential: Credential, action: "enable" | "disable" | "delete") {
    const deletingLastActive = action === "delete" && credential.status === "active"
      && credentials.filter((row) => row.status === "active").length === 1;
    if (action === "delete" && !window.confirm(
      `確定要軟刪除 ${credential.name}？刪除後不可再被 Gateway 選用。${deletingLastActive ? "\n警告：這是此 Provider 最後一組 Active Key。" : ""}`
    )) return;
    if (action === "disable" && !window.confirm(`確定要停用 ${credential.name}？`)) return;
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

  function renderQuotaDetails(credential: Credential) {
    const quotas = credential.modelQuotas ?? [];
    const providerId = (selectedProvider?.provider ?? "openai") as AiProviderId;
    return <tr key={`${credential.id}-quotas`} className="admin-quota-detail-row">
      <td colSpan={6}>
        <div className="admin-quota-list">
          <div className="admin-quota-list-header">
            <div>
              <strong>模型配額列表</strong>
              <span className="muted">（後端 API 用量資料）</span>
            </div>
            <button type="button" className="admin-btn secondary" onClick={() => void refreshCredentialQuotas(credential.id)} disabled={busy}>重新整理</button>
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
                    <button type="button" className="admin-btn secondary" onClick={() => editQuota(credential, quota)} disabled={busy}>編輯</button>
                    <button type="button" className="admin-btn secondary" onClick={() => void setDefaultQuota(quota)} disabled={busy || quota.isDefault || !quota.enabled}>{quota.isDefault ? "目前預設" : "設為預設"}</button>
                    <button type="button" className="admin-btn secondary" onClick={() => void toggleQuota(quota)} disabled={busy || quota.isDefault}>{quota.enabled ? "停用" : "啟用"}</button>
                    <button type="button" className="admin-btn danger" onClick={() => void deleteQuota(quota)} disabled={busy || quota.isDefault}>刪除</button>
                  </div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
        </div>
      </td>
    </tr>;
  }

  if (loading) return <p role="status">Provider 設定載入中…</p>;
  if (error && providers.length === 0 && !selectedProviderId) {
    return <AdminErrorCard title="Provider 設定無法載入" description={error} onRetry={() => void loadProviders()} />;
  }

  const credentialFieldError = (field: string) => credentialErrors[field]
    ? <span className="admin-field-error" role="alert">{credentialErrors[field]}</span>
    : null;

  return <div>
    <AdminPageHeader
      title="AI Provider 與 Credential"
      subtitle="API Key 僅在伺服器端加密保存；前端只會收到遮罩值與安全狀態 metadata。"
      actions={<button type="button" className="admin-btn" onClick={startNewProvider} disabled={busy}>新增 Provider</button>}
    />
    {message ? <p className="admin-inline-success" role="status">{message}</p> : null}
    {error ? <p className="admin-inline-error" role="alert">{error}</p> : null}

    <AdminCard title="Provider 清單">
      {providers.length === 0 ? <p className="muted">目前尚未建立 Provider，請先新增一個。</p> : <div className="admin-table-wrap">
        <table className="admin-table-compact">
          <thead><tr><th>Provider</th><th>Model</th><th>Priority</th><th>狀態</th><th>路由角色</th><th>操作</th></tr></thead>
          <tbody>{providers.map((provider) => <tr key={provider.id}>
            <td><strong>{provider.displayName}</strong><br /><span className="muted">{PROVIDER_LABELS[provider.provider]} · {provider.slug}</span></td>
            <td>{provider.model || "—"}</td>
            <td>{provider.priority}</td>
            <td>{provider.enabled ? "Enabled" : "Disabled"}</td>
            <td>{provider.isDefault ? "Default " : ""}{provider.isRouterProvider ? "Router" : ""}{!provider.isDefault && !provider.isRouterProvider ? "—" : ""}</td>
            <td><div className="admin-action-row admin-action-row-tight">
              <button type="button" className="admin-btn secondary" onClick={() => selectProvider(provider)} disabled={busy}>編輯／管理 Key</button>
              <button type="button" className="admin-btn danger" onClick={() => void deleteProvider(provider)} disabled={busy}>刪除</button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </AdminCard>

    <AdminCard title={selectedProvider ? `編輯 ${selectedProvider.displayName}` : "新增 Provider"}>
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
        <button type="button" className="admin-btn" onClick={() => void saveProvider()} disabled={busy}>{busy ? "處理中…" : "儲存 Provider"}</button>
        {selectedProvider ? <button type="button" className="admin-btn secondary" onClick={() => void toggleProvider()} disabled={busy}>{selectedProvider.enabled ? "停用 Provider" : "啟用 Provider"}</button> : null}
      </div>
      <p className="admin-help">Priority 會先於同層 weight；Credential 的 cooldown 與 failure count 由 Gateway 自動管理。</p>
    </AdminCard>

    {selectedProvider ? <AdminCard title={`${selectedProvider.displayName} 的 Credential`}>
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
        <button type="button" className="admin-btn" onClick={() => void saveCredential()} disabled={busy}>{busy ? "處理中…" : editingCredentialId ? "儲存 Credential" : "加密新增 Credential"}</button>
        {editingCredentialId ? <button type="button" className="admin-btn secondary" onClick={resetCredentialForm} disabled={busy}>取消編輯</button> : null}
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
          {editingCredentialId ? <button type="button" className="admin-btn" onClick={() => void saveQuota()} disabled={busy}>{editingQuotaId ? "儲存模型配額" : "新增模型配額"}</button> : <span className="admin-help">儲存 Credential 後會自動建立首次模型配額。</span>}
          {editingCredentialId ? <button type="button" className="admin-btn secondary" onClick={() => { setEditingQuotaId(null); setQuotaForm({ ...EMPTY_QUOTA, isDefault: false }); }} disabled={busy}>新增其他模型</button> : null}
          {editingQuotaId ? <button type="button" className="admin-btn secondary" onClick={() => { setEditingQuotaId(null); setQuotaForm({ ...EMPTY_QUOTA, isDefault: false }); }} disabled={busy}>取消編輯</button> : null}
        </div>
      </div>
      {credentialsLoading ? <p role="status">Credential 載入中…</p> : credentials.length === 0 ? <p className="muted">此 Provider 尚無 Credential。</p> : <div className="admin-table-wrap">
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
                <button type="button" className="admin-btn secondary" onClick={() => void testCredential(credential)} disabled={busy || credential.status === "disabled"}>測試</button>
                <button type="button" className="admin-btn secondary" onClick={() => editCredential(credential)} disabled={busy}>編輯</button>
                {credential.status === "disabled" ? <button type="button" className="admin-btn secondary" onClick={() => void credentialAction(credential, "enable")} disabled={busy}>啟用</button> : <button type="button" className="admin-btn secondary" onClick={() => void credentialAction(credential, "disable")} disabled={busy}>停用</button>}
                <button type="button" className="admin-btn danger" onClick={() => void credentialAction(credential, "delete")} disabled={busy}>刪除（軟刪除）</button>
              </div></td>
            </tr>
            {renderQuotaDetails(credential)}
          </Fragment>)}</tbody>
        </table>
      </div>}
    </AdminCard> : null}
  </div>;
}
