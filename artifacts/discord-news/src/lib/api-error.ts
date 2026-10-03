import { ApiError } from "@workspace/api-client-react";

export interface DescribedError {
  title: string;
  description: string;
}

function readServerMessage(data: unknown): string | null {
  if (data && typeof data === "object") {
    const obj = data as { error?: unknown; message?: unknown };
    if (typeof obj.error === "string" && obj.error.trim().length > 0) {
      return obj.error.trim();
    }
    if (typeof obj.message === "string" && obj.message.trim().length > 0) {
      return obj.message.trim();
    }
  }
  return null;
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function describeApiError(err: unknown): DescribedError {
  if (isApiError(err)) {
    const e = err as ApiError & { data: unknown; status: number; statusText?: string };
    const serverMsg = readServerMessage(e.data);
    switch (e.status) {
      case 401:
        return {
          title: "未授權",
          description: "請在側邊欄設定有效的管理金鑰後再試。",
        };
      case 403:
        return {
          title: "沒有權限",
          description: serverMsg ?? "目前的金鑰無法執行這個動作。",
        };
      case 429:
        return {
          title: "速率限制",
          description: serverMsg ?? "AI 觸發次數過於頻繁，請稍後再試。",
        };
      case 503:
        return {
          title: "尚未設定",
          description:
            serverMsg ?? "伺服器尚未配置 ADMIN_TOKEN，請先在環境變數設定後重啟。",
        };
      case 409:
        return {
          title: "已被處理",
          description: serverMsg ?? "這項建議已經被其他人採用或撤回了。",
        };
      case 400:
        return {
          title: "請求無效",
          description: serverMsg ?? "輸入內容不符合要求。",
        };
      default:
        return {
          title: `伺服器錯誤 (${e.status})`,
          description: serverMsg ?? e.statusText ?? "請稍後再試。",
        };
    }
  }
  if (err instanceof TypeError) {
    return {
      title: "連線失敗",
      description: "無法連到伺服器，請檢查網路或稍後重試。",
    };
  }
  return {
    title: "未知錯誤",
    description: err instanceof Error ? err.message : String(err ?? ""),
  };
}
