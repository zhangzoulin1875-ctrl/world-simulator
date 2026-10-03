import { eq, inArray } from "drizzle-orm";
import { db, playerNationsTable, type DiplomacyTreaty } from "@workspace/db";
import { getDiscordClient } from "./discordBot";
import { logger } from "./logger";
import { treatyTypeLabel, type RelationAction } from "./diplomacy";
import {
  persistNotificationInBackground,
  type NewPlayerNotification,
} from "./playerNotify";

/**
 * Task #41 — 外交事件 Discord 私訊通知。
 * 新外交訊息／條約提案／條約回覆／宣戰時，bot 私訊目標玩家（附網站連結）。
 * 私訊一律 fire-and-forget：失敗（對方關閉 DM、bot 離線）只記 log，
 * 絕不影響 API 主要流程。
 *
 * Task #79 — 站內通知：每個外交事件除了 DM 之外，也寫入收件玩家的站內
 * 通知（player_notifications，鈴鐺通知中心）。站內通知一律寫入，不受
 * DM 開關影響；唯一入口是 fireNotify（靜態測試強制 notify* 不得繞過）。
 */

// ── 純函式（單元測試） ─────────────────────────────────────────

/** 網站外交頁完整網址；SITE_URL 優先，否則用 REPLIT_DOMAINS 第一個網域。 */
export function diplomacySiteUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const site = env["SITE_URL"]?.trim();
  if (site) return `${site.replace(/\/+$/, "")}/game/diplomacy`;
  const first = env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
  if (first) return `https://${first}/game/diplomacy`;
  return null;
}

/** 私訊訊息末尾附上網站連結（無網址設定時省略）。 */
export function withSiteLink(text: string, url: string | null): string {
  return url ? `${text}\n👉 前往外交頁面：${url}` : text;
}

/**
 * 聊天訊息 DM 節流：同一（收件玩家 × 發訊國家）在冷卻時間內只私訊一次，
 * 避免對話中每則訊息都轟炸對方 DM。同步先佔位再送（避免併發重複）。
 */
export const MESSAGE_DM_COOLDOWN_MS = 10 * 60 * 1000;

export function claimMessageDmSlot(
  slots: Map<string, number>,
  key: string,
  now: number,
  cooldownMs: number = MESSAGE_DM_COOLDOWN_MS,
): boolean {
  const last = slots.get(key);
  if (last !== undefined && now - last < cooldownMs) return false;
  slots.set(key, now);
  // 順手清掉過期項目，避免 Map 無限成長。
  if (slots.size > 500) {
    for (const [k, t] of slots) {
      if (now - t >= cooldownMs) slots.delete(k);
    }
  }
  return true;
}

// ── DM 發送（fire-and-forget） ─────────────────────────────────

async function sendDm(discordUserId: string, content: string): Promise<void> {
  const client = getDiscordClient();
  if (!client || !client.isReady()) {
    logger.info({ discordUserId }, "diplomacy DM skipped: bot offline");
    return;
  }
  const user = await client.users.fetch(discordUserId);
  await user.send({ content });
}

/**
 * Task #47 — opt-out 純判斷：有國家列就看 flag，查不到國家（理論上不會發生）
 * 視為未關閉，照預設送出。單元測試直接覆蓋這三種情境。
 */
export function optedOutFromRow(
  row: { enabled: boolean } | undefined,
): boolean {
  return row ? !row.enabled : false;
}

/**
 * 收件玩家是否關閉了外交通知（player_nations.dm_diplomacy_enabled）。
 */
async function dmOptedOut(discordUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: playerNationsTable.dmDiplomacyEnabled })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, discordUserId))
    .limit(1);
  return optedOutFromRow(row);
}

/**
 * 收件玩家是否關閉了內政通知（player_nations.dm_politics_enabled）。
 * 供 politicsDm.ts 的每回合內政結算摘要私訊使用（與外交開關各自獨立）。
 */
async function politicsDmOptedOut(discordUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: playerNationsTable.dmPoliticsEnabled })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, discordUserId))
    .limit(1);
  return optedOutFromRow(row);
}

/**
 * DM 發送依賴（可注入，供測試替換）。
 * 所有外交通知都必須經過 deliverDm 這個 gate；
 * 測試會靜態檢查 notify* 沒有繞過 fireDm/deliverDm。
 */
export type DmDeps = {
  isOptedOut: (discordUserId: string) => Promise<boolean>;
  send: (discordUserId: string, content: string) => Promise<void>;
};

const defaultDmDeps: DmDeps = { isOptedOut: dmOptedOut, send: sendDm };
let dmDeps: DmDeps = defaultDmDeps;

/** 僅供測試：替換 DM 依賴；傳 null 還原預設。 */
export function __setDmDepsForTest(deps: DmDeps | null): void {
  dmDeps = deps ?? defaultDmDeps;
}

/**
 * 統一的 DM gate：先檢查玩家是否關閉外交通知，未關閉才真正送出。
 * 這是唯一允許呼叫 send 的地方 — 新增通知一律走 fireDm → deliverDm。
 */
export async function deliverDm(
  discordUserId: string,
  content: string,
  deps: DmDeps = dmDeps,
): Promise<void> {
  if (await deps.isOptedOut(discordUserId)) {
    logger.info(
      { discordUserId },
      "diplomacy DM skipped: player disabled diplomacy notifications",
    );
    return;
  }
  await deps.send(discordUserId, content);
}

const defaultPoliticsDmDeps: DmDeps = {
  isOptedOut: politicsDmOptedOut,
  send: sendDm,
};
let politicsDmDeps: DmDeps = defaultPoliticsDmDeps;

/** 僅供測試：替換內政 DM 依賴；傳 null 還原預設。 */
export function __setPoliticsDmDepsForTest(deps: DmDeps | null): void {
  politicsDmDeps = deps ?? defaultPoliticsDmDeps;
}

/**
 * 內政 DM gate：先檢查玩家是否關閉「內政」私訊，未關閉才送出。
 * 與 deliverDm（外交）共用底層送信，但各自看不同的開關欄位。
 */
export async function deliverPoliticsDm(
  discordUserId: string,
  content: string,
  deps: DmDeps = politicsDmDeps,
): Promise<void> {
  if (await deps.isOptedOut(discordUserId)) {
    logger.info(
      { discordUserId },
      "politics DM skipped: player disabled politics notifications",
    );
    return;
  }
  await deps.send(discordUserId, content);
}

/**
 * 站內通知寫入依賴（可注入，供測試替換）。預設 fire-and-forget 寫入
 * player_notifications；失敗只記 log，不影響主流程。
 */
export type PersistDep = (n: NewPlayerNotification) => void;
let persistDep: PersistDep = persistNotificationInBackground;

/** 僅供測試：替換站內通知寫入依賴；傳 null 還原預設。 */
export function __setPersistDepForTest(dep: PersistDep | null): void {
  persistDep = dep ?? persistNotificationInBackground;
}

/**
 * Task #79 — 外交事件的統一通知入口：
 * 1. 站內通知（一律寫入，不受 DM 開關影響）
 * 2. Discord 私訊（走 deliverDm 的 opt-out gate；任何錯誤只記 log，
 *    例如對方關閉 DM 的 50007）
 */
function fireNotify(
  discordUserId: string | null,
  event: { title: string; body: string },
  linkPath: string = "/game/diplomacy",
): void {
  if (!discordUserId) return;
  persistDep({
    discordUserId,
    type: "diplomacy",
    title: event.title,
    body: event.body,
    linkPath,
  });
  deliverDm(discordUserId, withSiteLink(event.body, diplomacySiteUrl())).catch(
    (err) => {
      logger.warn(
        { err, discordUserId },
        "diplomacy DM failed (recipient may have DMs disabled)",
      );
    },
  );
}

const messageDmSlots = new Map<string, number>();

/**
 * 新外交訊息 → 通知收件玩家（同一對話 10 分鐘內只提醒一次）。
 * 冷卻對站內通知與 DM「共用」：聊天訊息本身在通訊分頁就看得到，
 * 通知只是提醒；沿用同一冷卻可避免熱絡對話刷爆鈴鐺清單（Task #79 決定）。
 */
export function notifyDiplomacyMessage(params: {
  recipientDiscordUserId: string | null;
  senderNationId: string;
  senderNationName: string | null;
}): void {
  const { recipientDiscordUserId, senderNationId, senderNationName } = params;
  if (!recipientDiscordUserId) return;
  const key = `${recipientDiscordUserId}:${senderNationId}`;
  if (!claimMessageDmSlot(messageDmSlots, key, Date.now())) return;
  fireNotify(recipientDiscordUserId, {
    title: "新的外交訊息",
    body: `📨 「${senderNationName ?? "（未命名）"}」傳來了新的外交訊息。`,
  });
}

/** 新條約提案 → 私訊被提案的玩家。 */
export function notifyTreatyProposal(params: {
  targetDiscordUserId: string | null;
  proposerNationName: string | null;
  treatyType: string;
}): void {
  fireNotify(params.targetDiscordUserId, {
    title: "新的條約提案",
    body: `📜 「${params.proposerNationName ?? "（未命名）"}」向你提出「${treatyTypeLabel(params.treatyType)}」條約提案，等待你的回覆。`,
  });
}

/**
 * 條約被接受／拒絕 → 私訊條約的另一方（提案者）。
 * 自行查另一方國家的 Discord 帳號；查詢失敗也只記 log。
 */
export function notifyTreatyResponse(params: {
  treaty: Pick<DiplomacyTreaty, "proposerNationId" | "targetNationId" | "type">;
  responderNationId: string;
  responderNationName: string | null;
  accepted: boolean;
}): void {
  const otherNationId =
    params.treaty.proposerNationId === params.responderNationId
      ? params.treaty.targetNationId
      : params.treaty.proposerNationId;
  void (async () => {
    const [other] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, otherNationId))
      .limit(1);
    if (!other?.discordUserId) return;
    const verb = params.accepted ? "✅ 接受了" : "❌ 拒絕了";
    fireNotify(other.discordUserId, {
      title: params.accepted ? "條約提案被接受" : "條約提案被拒絕",
      body: `「${params.responderNationName ?? "（未命名）"}」${verb}你的「${treatyTypeLabel(params.treaty.type)}」條約提案。`,
    });
  })().catch((err) => {
    logger.warn({ err }, "diplomacy treaty response DM lookup failed");
  });
}

/**
 * 條約到期 → 私訊締約雙方（有 Discord 帳號的玩家）。
 * 由到期迴圈呼叫；同一條約只會被標記 expired 一次（UPDATE 只轉換 active 列），
 * 因此不會重複通知。查詢失敗只記 log。
 */
export function notifyTreatyExpired(params: {
  proposerNationId: string;
  targetNationId: string;
  treatyType: string;
}): void {
  void (async () => {
    const rows = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
        discordUserId: playerNationsTable.discordUserId,
      })
      .from(playerNationsTable)
      .where(
        inArray(playerNationsTable.id, [
          params.proposerNationId,
          params.targetNationId,
        ]),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const label = treatyTypeLabel(params.treatyType);
    for (const [selfId, otherId] of [
      [params.proposerNationId, params.targetNationId],
      [params.targetNationId, params.proposerNationId],
    ] as const) {
      const self = byId.get(selfId);
      if (!self?.discordUserId) continue;
      const otherName = byId.get(otherId)?.name ?? "（未命名）";
      fireNotify(self.discordUserId, {
        title: "條約到期",
        body: `⏳ 你與「${otherName}」的「${label}」已到期失效。`,
      });
    }
  })().catch((err) => {
    logger.warn({ err }, "diplomacy treaty expiry DM lookup failed");
  });
}

/**
 * 條約到期前預警 → 私訊締約雙方（有 Discord 帳號的玩家），提醒可重新締約。
 * 由到期迴圈呼叫；同一條約只會被認領預警一次（UPDATE ... WHERE expiry_warned_at
 * IS NULL RETURNING），因此不會重複通知。查詢失敗只記 log。
 */
export function notifyTreatyExpiringSoon(params: {
  proposerNationId: string;
  targetNationId: string;
  treatyType: string;
}): void {
  void (async () => {
    const rows = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
        discordUserId: playerNationsTable.discordUserId,
      })
      .from(playerNationsTable)
      .where(
        inArray(playerNationsTable.id, [
          params.proposerNationId,
          params.targetNationId,
        ]),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const label = treatyTypeLabel(params.treatyType);
    for (const [selfId, otherId] of [
      [params.proposerNationId, params.targetNationId],
      [params.targetNationId, params.proposerNationId],
    ] as const) {
      const self = byId.get(selfId);
      if (!self?.discordUserId) continue;
      const otherName = byId.get(otherId)?.name ?? "（未命名）";
      fireNotify(self.discordUserId, {
        title: "條約即將到期",
        body: `⏰ 你與「${otherName}」的「${label}」即將到期（24 小時內），若要維持效力，請把握時間重新締約。`,
      });
    }
  })().catch((err) => {
    logger.warn({ err }, "diplomacy treaty expiring-soon DM lookup failed");
  });
}

/**
 * 條約被廢除 → 私訊條約的另一方。
 * 自行查另一方國家的 Discord 帳號；查詢失敗也只記 log。
 */
export function notifyTreatyAnnulled(params: {
  treaty: Pick<DiplomacyTreaty, "proposerNationId" | "targetNationId" | "type">;
  annullerNationId: string;
  annullerNationName: string | null;
}): void {
  const otherNationId =
    params.treaty.proposerNationId === params.annullerNationId
      ? params.treaty.targetNationId
      : params.treaty.proposerNationId;
  void (async () => {
    const [other] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, otherNationId))
      .limit(1);
    if (!other?.discordUserId) return;
    fireNotify(other.discordUserId, {
      title: "條約被廢除",
      body: `🗑️ 「${params.annullerNationName ?? "（未命名）"}」廢除了你們之間的「${treatyTypeLabel(params.treaty.type)}」條約，兩國關係大幅惡化。`,
    });
  })().catch((err) => {
    logger.warn({ err }, "diplomacy treaty annul DM lookup failed");
  });
}

/**
 * Task #71 — 條約提案被撤回 → 私訊條約的另一方。
 * 撤回不影響關係分數；查詢失敗也只記 log。
 */
export function notifyTreatyWithdrawn(params: {
  treaty: Pick<DiplomacyTreaty, "proposerNationId" | "targetNationId" | "type">;
  withdrawerNationId: string;
  withdrawerNationName: string | null;
}): void {
  const otherNationId =
    params.treaty.proposerNationId === params.withdrawerNationId
      ? params.treaty.targetNationId
      : params.treaty.proposerNationId;
  void (async () => {
    const [other] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, otherNationId))
      .limit(1);
    if (!other?.discordUserId) return;
    fireNotify(other.discordUserId, {
      title: "條約提案被撤回",
      body: `↩️ 「${params.withdrawerNationName ?? "（未命名）"}」撤回了先前向你提出的「${treatyTypeLabel(params.treaty.type)}」條約提案。`,
    });
  })().catch((err) => {
    logger.warn({ err }, "diplomacy treaty withdraw DM lookup failed");
  });
}

/**
 * Task #214 — 自訂條約每回合經常性轉移因餘額不足而略過 → 通知付款方。
 * missing = 缺額項目摘要（例如「金錢 100、科技點數 5」）。
 */
export function notifyCustomTreatyShortfall(params: {
  payerDiscordUserId: string | null;
  missing: string;
}): void {
  fireNotify(params.payerDiscordUserId, {
    title: "自訂條約履約失敗",
    body: `⚠️ 本回合自訂條約的經常性轉移因餘額不足而未能履行（${params.missing}），請盡快補足以免影響關係。`,
  });
}

/** 附庸貢金因附庸餘額不足而全額跳過 → 通知附庸玩家。 */
export function notifyVassalTributeShortfall(params: {
  vassalDiscordUserId: string | null;
  tribute: number;
}): void {
  fireNotify(params.vassalDiscordUserId, {
    title: "附庸貢金未能上繳",
    body: `⚠️ 本回合應上繳宗主的貢金 ${params.tribute} 因國庫餘額不足而未能履行，請盡快補足以免影響與宗主的關係。`,
  });
}

/** 附庸請求宣戰／聯盟行動的同意 → 通知真人宗主玩家。 */
export function notifyVassalConsentRequested(params: {
  suzerainDiscordUserId: string | null;
  vassalNationName: string | null;
  actionLabel: string;
  subjectName: string | null;
}): void {
  fireNotify(params.suzerainDiscordUserId, {
    title: "附庸請求同意",
    body: `🤝 附庸「${params.vassalNationName ?? "（未命名）"}」請求進行「${params.actionLabel}${params.subjectName ? `：${params.subjectName}` : ""}」，等待你的批准（外交頁 → 條約分頁）。`,
  });
}

/** 宗主批准／拒絕附庸的同意請求 → 通知附庸玩家。 */
export function notifyVassalConsentDecided(params: {
  vassalDiscordUserId: string | null;
  suzerainNationName: string | null;
  actionLabel: string;
  subjectName: string | null;
  approved: boolean;
}): void {
  const subject = params.subjectName ? `：${params.subjectName}` : "";
  fireNotify(params.vassalDiscordUserId, {
    title: params.approved ? "宗主批准了你的請求" : "宗主拒絕了你的請求",
    body: params.approved
      ? `✅ 宗主國「${params.suzerainNationName ?? "（未命名）"}」批准了「${params.actionLabel}${subject}」，現在可以執行該行動了。`
      : `❌ 宗主國「${params.suzerainNationName ?? "（未命名）"}」拒絕了「${params.actionLabel}${subject}」。`,
  });
}

/** 被宣戰 → 私訊目標玩家。 */
export function notifyWarDeclared(params: {
  targetDiscordUserId: string | null;
  declarerNationName: string | null;
}): void {
  fireNotify(params.targetDiscordUserId, {
    title: "遭到宣戰",
    body: `⚔️ 「${params.declarerNationName ?? "（未命名）"}」對你的國家宣戰了！`,
  });
}

/**
 * 交戰中的敵國領土全數淪陷、於回合結算被自動除名 → 通知真人對手戰爭自動結束。
 * NPC↔NPC 戰爭列不應存在（鐵則），故此通知只會發給真人對手；對手為 NPC／
 * 無主國家（無 Discord 帳號）時，fireNotify 會自動略過。
 */
export function notifyWarEndedByElimination(params: {
  recipientDiscordUserId: string | null;
  eliminatedNationName: string | null;
}): void {
  fireNotify(params.recipientDiscordUserId, {
    title: "戰爭結束：敵國已滅亡",
    body: `🏳️ 「${params.eliminatedNationName ?? "（未命名）"}」的領土已全數淪陷、就此滅亡，你們之間的戰爭自動結束。`,
  });
}

/**
 * Task #108 — 交流（親善）動作 → 通知承受方。
 * 被侮辱（−20）／被撤館（−40）等關係惡化事件即時提醒承受方，
 * 送禮／設館等正面動作以正面語氣一併通知。
 * linkPath 帶對方國家（?nation=<發動方國家 id>），點擊直達外交頁交流分頁並選定該國。
 * 承受方為 NPC／無主國家（無 Discord 帳號）時，fireNotify 會自動略過。
 */
export function notifyRelationAction(params: {
  targetDiscordUserId: string | null;
  actorNationId: string;
  actorNationName: string | null;
  action: RelationAction;
}): void {
  const actor = params.actorNationName ?? "（未命名）";
  const events: Record<RelationAction, { title: string; body: string }> = {
    embassy: {
      title: "他國派駐大使館",
      body: `🏛️ 「${actor}」在你的國家派駐了大使館，兩國關係提升。`,
    },
    gift: {
      title: "收到他國禮物",
      body: `🎁 「${actor}」向你的國家送禮，兩國關係提升。`,
    },
    insult: {
      title: "遭到他國侮辱",
      body: `💢 「${actor}」對你的國家送出了污辱，兩國關係惡化。`,
    },
    withdraw: {
      title: "他國撤館",
      body: `🚪 「${actor}」自你的國家撤回了外交官，兩國關係大幅惡化。`,
    },
  };
  fireNotify(
    params.targetDiscordUserId,
    events[params.action],
    `/game/diplomacy?nation=${encodeURIComponent(params.actorNationId)}`,
  );
}

// ── Task #215：聯盟事件通知 ────────────────────────────────────────
const ALLIANCE_LINK = "/game/diplomacy?tab=alliance";

/** 被邀請加入聯盟 → 通知受邀國。 */
export function notifyAllianceInvited(params: {
  targetDiscordUserId: string | null;
  allianceName: string;
}): void {
  fireNotify(
    params.targetDiscordUserId,
    {
      title: "收到聯盟邀請",
      body: `🤝 「${params.allianceName}」邀請你的國家加入聯盟，等待你的回覆。`,
    },
    ALLIANCE_LINK,
  );
}

/** 有國家申請加入我方聯盟 → 通知創始國（依 nationId 查 Discord 帳號）。 */
export function notifyAllianceApplicationReceived(params: {
  founderNationId: string;
  applicantNationName: string | null;
  allianceName: string;
}): void {
  void (async () => {
    const [founder] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, params.founderNationId))
      .limit(1);
    if (!founder?.discordUserId) return;
    fireNotify(
      founder.discordUserId,
      {
        title: "收到入盟申請",
        body: `📨 「${params.applicantNationName ?? "（未命名）"}」申請加入你的聯盟「${params.allianceName}」，等待你的核准。`,
      },
      ALLIANCE_LINK,
    );
  })().catch((err) => {
    logger.warn({ err }, "alliance application DM lookup failed");
  });
}

/** 入盟申請被核准 → 通知申請國（依 nationId 查 Discord 帳號）。 */
export function notifyAllianceApplicationApproved(params: {
  applicantNationId: string;
  allianceName: string;
}): void {
  void (async () => {
    const [applicant] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, params.applicantNationId))
      .limit(1);
    if (!applicant?.discordUserId) return;
    fireNotify(
      applicant.discordUserId,
      {
        title: "入盟申請通過",
        body: `✅ 你的國家已加入聯盟「${params.allianceName}」。`,
      },
      ALLIANCE_LINK,
    );
  })().catch((err) => {
    logger.warn({ err }, "alliance application approved DM lookup failed");
  });
}

/** 被逐出聯盟 → 通知被踢國（依 nationId 查 Discord 帳號）。 */
export function notifyAllianceKicked(params: {
  targetNationId: string;
  allianceName: string;
}): void {
  void (async () => {
    const [target] = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, params.targetNationId))
      .limit(1);
    if (!target?.discordUserId) return;
    fireNotify(
      target.discordUserId,
      {
        title: "被逐出聯盟",
        body: `🚪 你的國家已被移出聯盟「${params.allianceName}」。`,
      },
      ALLIANCE_LINK,
    );
  })().catch((err) => {
    logger.warn({ err }, "alliance kick DM lookup failed");
  });
}

/** 聯盟解散 → 通知所有其餘成員（依 nationId 查 Discord 帳號）。 */
export function notifyAllianceDisbanded(params: {
  memberNationIds: string[];
  allianceName: string;
}): void {
  if (params.memberNationIds.length === 0) return;
  void (async () => {
    const rows = await db
      .select({ discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.id, params.memberNationIds));
    for (const r of rows) {
      if (!r.discordUserId) continue;
      fireNotify(
        r.discordUserId,
        {
          title: "聯盟已解散",
          body: `💔 你所屬的聯盟「${params.allianceName}」已解散。`,
        },
        ALLIANCE_LINK,
      );
    }
  })().catch((err) => {
    logger.warn({ err }, "alliance disband DM lookup failed");
  });
}
