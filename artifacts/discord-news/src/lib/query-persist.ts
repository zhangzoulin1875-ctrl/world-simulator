import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

/**
 * 快取版本 buster。正式建置時帶上該次建置的唯一 id——每次部署後，
 * 舊的持久化快取會在還原時自動失效被丟棄，避免新版程式讀到
 * 不相容形狀的過期資料而在渲染時崩潰。開發模式為固定值。
 *
 * 慣例：API 回應形狀有「破壞性變更」（新增前端必讀欄位、改名、
 * 改巢狀結構）時，必須同步提升下方的版本前綴（v3 → v4 → …），
 * 讓合併前存下的舊形狀快照在還原時被丟棄，而不是 hydrate 進新版
 * UI 造成 undefined% / 渲染崩潰。開發與正式共用同一個前綴。
 */
export const CACHE_BUSTER =
  typeof __BUILD_ID__ !== "undefined" ? `v3-${__BUILD_ID__}` : "v3";

/** 持久化快取在 localStorage 的鍵。 */
const PERSIST_KEY = "discord-news.query-cache";

/**
 * 記錄「這份持久化快取屬於哪位 Discord 使用者」的標記鍵。
 * 用來在換人登入 / 登出時判斷是否要清掉前一位使用者殘留的資料。
 */
const USER_MARKER_KEY = "discord-news.query-cache.user";

/** 快取最長保存時間：24 小時。超過即視為過期，還原時丟棄。 */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      // 讓非使用中的查詢在記憶體中保留到與 maxAge 相同的時間，
      // 這樣持久化的快照才不會因為 GC 而提早被清空。
      gcTime: PERSIST_MAX_AGE,
    },
  },
});

/** localStorage 版的持久化器；SSR / 無 window 時為 undefined。 */
export const queryPersister =
  typeof window !== "undefined"
    ? createSyncStoragePersister({
        storage: window.localStorage,
        key: PERSIST_KEY,
        throttleTime: 1000,
      })
    : undefined;

/** 直接清除 localStorage 內的持久化快取。 */
export function clearPersistedQueryCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PERSIST_KEY);
  } catch {
    // ignore
  }
}

/** 讀取目前持久化快取所屬的使用者標記（null = 匿名 / 無）。 */
export function getCacheUserMarker(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(USER_MARKER_KEY);
  } catch {
    return null;
  }
}

/** 設定持久化快取所屬的使用者標記；傳 null 代表清除標記。 */
export function setCacheUserMarker(userId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) {
      window.localStorage.setItem(USER_MARKER_KEY, userId);
    } else {
      window.localStorage.removeItem(USER_MARKER_KEY);
    }
  } catch {
    // ignore
  }
}
