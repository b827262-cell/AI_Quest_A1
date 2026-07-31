import { ApiHttpError, type CredentialTestDetails, type CredentialTestResponse } from "./api";

const FIELD_LABELS: Record<string, string> = {
  name: "名稱",
  apiKey: "API Key",
  baseUrl: "Credential Base URL",
  model: "Model",
  endpointProfile: "Endpoint Profile",
  status: "狀態",
  priority: "Priority",
  weight: "Weight",
  rpmLimit: "RPM",
  tpmLimit: "TPM",
  rpdLimit: "RPD",
  resetTimezone: "每日重置時區",
  isDefaultModel: "預設模型"
};

export function credentialFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

const TEST_REASON_LABELS: Record<string, string> = {
  valid: "連線正常",
  local_validation_failed: "本機 Credential 驗證失敗",
  provider_instance_not_found: "找不到對應的 Provider Instance",
  endpoint_profile_missing: "缺少 Endpoint Profile",
  wrong_endpoint_profile: "Endpoint Profile 不符合",
  wrong_auth_scheme: "Authentication Scheme 不符合",
  multiple_auth_credentials: "偵測到重複的 Authentication",
  invalid_api_key: "Provider 拒絕此 API Key",
  permission_denied: "Provider 拒絕此 API Key 的權限",
  access_denied: "Provider 拒絕存取",
  api_not_enabled: "Provider API 尚未啟用",
  api_restriction_mismatch: "API 限制與 Endpoint 不符合",
  model_not_available: "Model 不可用",
  rate_limited: "已達速率限制",
  quota_exhausted: "Provider 配額已耗盡",
  provider_timeout: "Provider 連線逾時",
  provider_unavailable: "Provider 服務暫時無法使用",
  unknown: "測試結果未分類"
};

export function credentialTestReasonLabel(reason?: string): string {
  return TEST_REASON_LABELS[reason ?? ""] ?? TEST_REASON_LABELS.unknown;
}

function endpointProfileLabel(profile: string | null | undefined): string {
  switch (profile) {
    case "gemini_native": return "Gemini Native API";
    case "gemini_openai_compatible": return "Gemini OpenAI-Compatible API";
    default: return profile ? "已設定 Endpoint Profile" : "未設定";
  }
}

export function credentialTestResultMessage(result: CredentialTestResponse | CredentialTestDetails): string {
  const status = "status" in result && result.status === "success" ? "成功" : "失敗";
  return `連線測試${status}：${credentialTestReasonLabel(result.reason)}；耗時：${result.latencyMs} ms；Endpoint Profile：${endpointProfileLabel(result.endpointProfile)}；上游請求：${result.upstreamRequestSent ? "已送出" : "未送出"}`;
}

export function credentialErrorMessage(error: unknown, operation: "save" | "test" | "delete"): string {
  if (!(error instanceof ApiHttpError)) {
    return operation === "test"
      ? "Credential 連線測試失敗；第三方錯誤內容已隱去。"
      : "Credential 操作失敗，請稍後再試。";
  }
  if (error.code === "validation_error") {
    const fields = Object.keys(error.fields ?? {}).map(credentialFieldLabel);
    return fields.length > 0
      ? `Credential 欄位格式不正確：${[...new Set(fields)].join("、")}。`
      : "Credential 欄位格式不正確，請檢查輸入內容。";
  }
  if (operation === "test" && error.details) return credentialTestResultMessage(error.details);
  if (error.code === "provider_not_found") return "Provider 已不存在，請重新整理清單。";
  if (error.code === "credential_already_exists" || error.status === 409) {
    return "Credential 名稱或 API Key 已存在，請更換後再試。";
  }
  if (error.code === "credential_vault_unavailable") {
    return "Credential vault 尚未就緒，請稍後再試。";
  }
  if (error.code === "credential_encryption_failed") return "Credential 加密失敗，請稍後再試。";
  if (error.code === "credential_storage_failed") return "Credential 儲存失敗，請稍後再試。";
  if (error.status === 404) return "Credential 已不存在，請重新整理清單。";
  if (error.status === 503) {
    return operation === "test"
      ? "Credential 連線暫時無法使用，請稍後再測試；第三方錯誤內容已隱去。"
      : "Credential 服務尚未就緒，請稍後再試。";
  }
  return operation === "test"
    ? "Credential 連線測試失敗；第三方錯誤內容已隱去。"
    : "Credential 操作失敗，請稍後再試。";
}

export function credentialFieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiHttpError ? (error.fields ?? {}) : {};
}

export function credentialFormAfterFailure<T extends { apiKey: string }>(form: T, clearApiKey: boolean): T {
  return clearApiKey ? { ...form, apiKey: "" } : form;
}
