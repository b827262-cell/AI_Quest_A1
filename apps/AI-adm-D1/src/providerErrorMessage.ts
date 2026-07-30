import { ApiHttpError } from "./api";

export function providerErrorMessage(error: unknown): string {
  if (!(error instanceof ApiHttpError)) return "Provider 操作失敗，請稍後再試。";
  if (error.code === "provider_identity_conflict") {
    if (error.fields?.slug) return "此 Provider Slug 已存在，請使用其他 Slug。";
    if (error.fields?.displayName) return "此 Provider 顯示名稱已存在，請使用其他名稱。";
    return "Provider 顯示名稱或 Slug 已存在，請使用不同值。";
  }
  if (error.code === "provider_already_exists") return "此 Provider 顯示名稱或 Slug 已存在，請使用不同值。";
  if (error.code === "validation_error") {
    const labels: Record<string, string> = {
      provider: "Provider",
      displayName: "顯示名稱",
      baseUrl: "Base URL",
      model: "Model",
      priority: "Priority"
    };
    const fields = Object.keys(error.fields ?? {}).map((field) => labels[field] ?? field);
    return fields.length > 0
      ? `Provider 欄位格式不正確：${[...new Set(fields)].join("、")}。`
      : "Provider 欄位格式不正確，請檢查輸入內容。";
  }
  if (error.code === "unexpected_error") return "Provider 操作失敗，請稍後再試。";
  if (error.status === 409) return "Provider 顯示名稱或 Slug 已存在，請使用不同值。";
  return "Provider 操作失敗，請稍後再試。";
}
