import { ApiHttpError } from "./api";

export type AdminErrorCategory = "auth_required" | "origin_forbidden" | "server_error" | "network_error" | "other";

export interface CategorizedAdminError {
  category: AdminErrorCategory;
  status: number | null;
  message: string;
}

export function categorizeAdminError(error: unknown): CategorizedAdminError {
  if (error instanceof ApiHttpError) {
    if (error.status === 401) {
      return {
        category: "auth_required",
        status: 401,
        message: "管理者驗證失敗 (401 Unauthorized)：請檢查 ADMIN_API_TOKEN 設定，或確保請求已透過代理伺服器注入驗證 Token。"
      };
    }
    if (error.status === 403) {
      return {
        category: "origin_forbidden",
        status: 403,
        message: "請求來源不受允許 (403 Forbidden)：目前 Origin 不在允許清單中，請將 Tailscale IP / MagicDNS 加入 ADMIN_ALLOWED_ORIGINS 設定。"
      };
    }
    if (error.status >= 500) {
      return {
        category: "server_error",
        status: error.status,
        message: `後端服務異常 (${error.status} Server Error)：API 伺服器內部錯誤，請檢查伺服器日誌。`
      };
    }
    return {
      category: "other",
      status: error.status,
      message: error.message || `請求失敗 (${error.status})`
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const isNetwork =
    error instanceof TypeError ||
    rawMessage.includes("Failed to fetch") ||
    rawMessage.includes("NetworkError") ||
    rawMessage.includes("fetch");

  if (isNetwork) {
    return {
      category: "network_error",
      status: null,
      message: "網路連線失敗 (Network Error)：無法存取後端 API，請檢查網路與伺服器連線狀態。"
    };
  }

  return {
    category: "other",
    status: null,
    message: rawMessage || "操作失敗，請稍後再試。"
  };
}

export function formatAdminErrorMessage(error: unknown, fallbackMessage?: string): string {
  const categorized = categorizeAdminError(error);
  if (categorized.category !== "other") {
    return categorized.message;
  }
  if (error instanceof ApiHttpError && error.message) {
    return error.message;
  }
  return fallbackMessage || categorized.message;
}
