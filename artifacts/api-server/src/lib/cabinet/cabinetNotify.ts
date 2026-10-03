import {
  persistNotificationInBackground,
  type NewPlayerNotification,
} from "../playerNotify";

/**
 * Task #242 — 內閣站內通知（type="cabinet"）。
 * 大臣提出待批准事項、時代更替導致大臣更替等事件，寫入玩家的站內通知
 * （鈴鐺）。內閣通知一律只走站內（不發 DM），與軍事／政治事件一致；
 * 失敗只記 log，不影響主流程（persistNotificationInBackground 為 fire-and-forget）。
 */

export type CabinetPersistDep = (n: NewPlayerNotification) => void;
let persistDep: CabinetPersistDep = persistNotificationInBackground;

/** 僅供測試：替換站內通知寫入依賴；傳 null 還原預設。 */
export function __setCabinetPersistDepForTest(
  dep: CabinetPersistDep | null,
): void {
  persistDep = dep ?? persistNotificationInBackground;
}

const CABINET_LINK = "/game/cabinet";

/** 內閣事件 → 玩家站內通知（無 Discord 帳號者略過）。 */
export function fireCabinetNotify(
  discordUserId: string | null,
  event: { title: string; body: string },
  linkPath: string = CABINET_LINK,
): void {
  if (!discordUserId) return;
  persistDep({
    discordUserId,
    type: "cabinet",
    title: event.title,
    body: event.body,
    linkPath,
  });
}

/** 大臣提出待批准事項 → 通知玩家。 */
export function notifyCabinetApprovalPending(params: {
  discordUserId: string | null;
  ministerName: string;
  domainLabel: string;
  summary: string;
}): void {
  fireCabinetNotify(params.discordUserId, {
    title: "內閣待批准事項",
    body: `📋 ${params.domainLabel}「${params.ministerName}」提出待批准事項：${params.summary}`,
  });
}

/** 時代更替導致大臣更替 → 通知玩家重新任命。 */
export function notifyCabinetMinistersRenewed(params: {
  discordUserId: string | null;
  eraLabel: string;
}): void {
  fireCabinetNotify(params.discordUserId, {
    title: "內閣改組",
    body: `🕰️ 時代已進入「${params.eraLabel}」，原內閣大臣皆已卸任，請前往內閣重新任命。`,
  });
}
