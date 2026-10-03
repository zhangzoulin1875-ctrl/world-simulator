/**
 * 說明／新手教學的「首次到訪」與「已完成」狀態，全部存在瀏覽器本機（localStorage）。
 *
 * - 狀態以「目前登入的 Discord 使用者」做區隔，避免同一瀏覽器不同帳號互相影響。
 * - 無法取得玩家身分（未登入 / 讀取中）時，退回以瀏覽器為單位（scope = "anon"）。
 * - 純前端資料，不進後端、不進 OpenAPI 規格。
 *
 * 純儲存邏輯（不含 React）放在 help-storage-core.ts，方便單元測試；此檔僅補上
 * 依賴 React 的 useHelpScope，並轉出（re-export）核心 API 供既有匯入點沿用。
 */
import { useCurrentUser } from "@/lib/current-user";
import { ANON_SCOPE } from "./help-storage-core";

export {
  isHelpSeen,
  markHelpSeen,
  isOnboardingDone,
  markOnboardingDone,
  ANON_SCOPE,
} from "./help-storage-core";

/**
 * 取得目前使用者的儲存範圍字串。回傳登入者的 Discord ID，
 * 未登入或尚在讀取時回傳 "anon"。
 */
export function useHelpScope(): string {
  const { data: me } = useCurrentUser();
  if (me?.authenticated && me.user?.discordUserId) return me.user.discordUserId;
  return ANON_SCOPE;
}
