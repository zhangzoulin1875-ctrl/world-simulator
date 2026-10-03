import { persistNotificationInBackground } from "./playerNotify";
import {
  buildGiftNotification,
  type GiftDirection,
  type GiftResource,
} from "./gifts";
import { ERAS } from "./mapRegionEras";

/**
 * Task #87 — 軍事與政治事件的站內通知（鈴鐺通知中心）。
 *
 * 與外交（diplomacyNotify.ts 的 fireNotify）不同，這裡「只」寫站內通知，
 * 不發 Discord 私訊 — 這些事件多為每日回合的例行結果，DM 會太吵；
 * 站內通知一律寫入，不受 dm_notifications_enabled 開關影響。
 * 全部 fire-and-forget：失敗只記 log，絕不影響回合結算／API 主流程。
 */

/** 管理員普發／贈送資源（科技點數 or 金錢）給某玩家國家。 */
export function notifyGiftReceived(params: {
  discordUserId: string;
  resource: GiftResource;
  amount: number;
  note: string | null;
  durationTurns?: number | null;
  direction?: GiftDirection | null;
}): void {
  const { title, body } = buildGiftNotification(
    params.resource,
    params.amount,
    params.note,
    { durationTurns: params.durationTurns, direction: params.direction },
  );
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "gift",
    title,
    body,
    linkPath: "/game",
  });
}

/** 軍事科技研發完成。 */
export function notifyMilitaryResearchComplete(params: {
  discordUserId: string;
  techName: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "科技研發完成",
    body: `🔬 「${params.techName}」研發完成，加成已生效。`,
    linkPath: "/game/military/research",
  });
}

/** Task #469 — 科技樹研發完成（回合結算）。 */
export function notifyTechTreeResearchComplete(params: {
  discordUserId: string;
  domainLabel: string;
  techName: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "tech",
    title: "科技研發完成",
    body: `🔬 ${params.domainLabel}科技「${params.techName}」研發完成，效果已生效。`,
    linkPath: "/game/technology",
  });
}

/** Task #469 — 領域時代推進（主幹線全完成）。 */
export function notifyTechTreeEraAdvanced(params: {
  discordUserId: string;
  domainLabel: string;
  eraSlug: string;
}): void {
  const era = ERAS.find((e) => e.slug === params.eraSlug);
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "tech",
    title: `${params.domainLabel}領域進入新時代`,
    body: `🏛️ 你的${params.domainLabel}領域已完成本時代全部主幹線科技，進入「${era?.label ?? params.eraSlug}」！`,
    linkPath: "/game/technology",
  });
}

/** 每日維護費超過國庫（金錢被扣到 0，仍有缺口）。 */
export function notifyUpkeepShortfall(params: {
  discordUserId: string;
  upkeep: number;
  income: number;
  shortfall: number;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "軍隊維護費不足",
    body: `⚠️ 本回合軍隊維護費 ${params.upkeep.toLocaleString("zh-TW")} 超過國庫可支付額度（缺口 ${params.shortfall.toLocaleString("zh-TW")}），金錢已歸零。財政赤字重創民心：四階級滿意度與穩定度大減、暴動度上升。請考慮解編部分軍隊、調整稅率或提升生產力。`,
    linkPath: "/game/military",
  });
}

/** 國庫歸零（無赤字缺口，但回合結束時金錢為 0）→ 民心動搖。 */
export function notifyTreasuryEmpty(params: { discordUserId: string }): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: "國庫見底",
    body: "💸 回合結束時國庫已歸零，民心動搖：四階級滿意度與穩定度下滑、暴動度上升。請調整稅率或削減支出，讓國庫恢復盈餘。",
    linkPath: "/game/economy",
  });
}

/**
 * Task #382 — 飢荒：糧食產出 < 消耗，本回合扣人口。站內通知即可。
 * Task #443 — 帶入連續饑荒回合數；連續多回合時升級告警文案並說明
 * 損失緩衝機制（扣幅遞減＋生還者保底）。
 */
export function notifyFamine(params: {
  discordUserId: string;
  populationLost: number;
  consecutiveTurns?: number;
}): void {
  const turns = Math.max(1, params.consecutiveTurns ?? 1);
  const lossText =
    params.populationLost > 0
      ? `本回合人口減少 ${params.populationLost.toLocaleString("zh-TW")} 人。`
      : "人口已觸及饑荒生還者保底，本回合未再折損，但饑荒仍未解除。";
  const streakText =
    turns > 1
      ? `⚠️ 這已是連續第 ${turns.toLocaleString("zh-TW")} 回合饑荒！為避免人口被清零，扣幅已隨連續回合遞減並設有生還者保底，但長期饑荒仍會拖垮國家，請儘速處理。`
      : "";
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "economy",
    title:
      turns > 1
        ? `全國饑荒持續中（連續第 ${turns.toLocaleString("zh-TW")} 回合）`
        : "全國爆發飢荒",
    body: `🌾 糧食產出不足以養活全國人口，飢荒爆發！${lossText}${streakText}請提高農民比例、啟用糧食政策或減少軍隊規模。`,
    linkPath: "/game/economy",
  });
}

/**
 * Task #184 — 每日回合推進：通知所有有主國家「回合已更新」。
 * 站內通知即可（回合為例行事件，不另發 DM）；連結到遊戲首頁。
 */
export function notifyTurnAdvanced(params: {
  discordUserId: string;
  year: number;
  eraLabel: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "turn",
    title: "回合更新",
    body: `⏳ 新的回合開始了！遊戲時間已推進至西元 ${params.year} 年（${params.eraLabel}）。前往遊戲首頁查看本回合的最新局勢與新聞。`,
    linkPath: "/game",
  });
}

/** 世界進入新時代（回合引擎跨越時代門檻時，通知所有有主國家）。 */
export function notifyEraChanged(params: {
  discordUserId: string;
  eraLabel: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "world",
    title: `世界進入了「${params.eraLabel}」`,
    body: `🌍 新時代來臨！各地區的人口、生產與科技數值全面改變，可能有新兵種解鎖。前往遊戲首頁查看新時代的世界。`,
    linkPath: "/game",
  });
}

/**
 * Task #176 — 自動世界模擬使世界局勢在玩家鄰近地區發生變動（NPC 崛起／消亡、
 * 領土重畫）。每回合每位受影響玩家最多一則彙總通知（非逐筆操作）。
 */
export function notifyWorldChanged(params: {
  discordUserId: string;
  summary: string;
}): void {
  const chars = Array.from(params.summary.trim());
  const excerpt =
    chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : chars.join("");
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "world",
    title: "鄰近世界局勢變動",
    body: `🌍 你周邊的世界正在改變${excerpt ? `：${excerpt}` : ""}。前往世界地圖查看最新局勢。`,
    linkPath: "/game/map",
  });
}

/** 政策想法判定結果（成功／失敗）。body 帶入玩家原始想法摘要，方便對照。 */
export function notifyPolicyJudged(params: {
  discordUserId: string;
  title: string;
  /** 玩家當初提出的政策想法原文。 */
  idea: string;
  succeeded: boolean;
}): void {
  const ideaChars = Array.from(params.idea.trim());
  const excerpt =
    ideaChars.length > 60
      ? `${ideaChars.slice(0, 60).join("")}…`
      : ideaChars.join("");
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.succeeded ? "政策推行成功" : "政策推行失敗",
    body: params.succeeded
      ? `📜 你提出的政策想法「${excerpt}」通過了——「${params.title}」已正式生效。`
      : `📉 你提出的政策想法「${excerpt}」推行失敗——「${params.title}」，國家蒙受損失。`,
    linkPath: "/game/politics",
  });
}

/** Task #402 — 軍方事件（越權/暴動、逃兵、軍事政變前奏等）。 */
export function notifyMilitaryPoliticsEvent(params: {
  discordUserId: string;
  title: string;
  body: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.title,
    body: params.body,
    linkPath: "/game/politics",
  });
}

/** 政治隨機事件發生。 */
export function notifyPoliticsEvent(params: {
  discordUserId: string;
  title: string;
  good: boolean;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.good ? "國內發生好事" : "國內發生變故",
    body: `${params.good ? "🎉" : "🌩️"} 「${params.title}」— 前往內政頁面查看影響。`,
    linkPath: "/game/politics",
  });
}

/** 政變／叛亂爆發。 */
export function notifyCoup(params: {
  discordUserId: string;
  title: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: "政變爆發！",
    body: `🔥 「${params.title}」— 你的國家爆發政變，政局被打回原點：各項滿意度、穩定度與支持度全數重置，短期內無法推行政策與設計兵種，軍隊士氣暫時低落。`,
    linkPath: "/game/politics",
  });
}

/** Task #127 — 政府決策判定結果（成功／失敗）。body 帶入玩家原始決策摘要。 */
export function notifyGovernmentDecision(params: {
  discordUserId: string;
  title: string;
  decision: string;
  succeeded: boolean;
}): void {
  const chars = Array.from(params.decision.trim());
  const excerpt =
    chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : chars.join("");
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.succeeded ? "政府決策成功" : "政府決策受挫",
    body: params.succeeded
      ? `🏛️ 你的政府決策「${excerpt}」順利推行——「${params.title}」，政治支持度上升。`
      : `📉 你的政府決策「${excerpt}」推行受挫——「${params.title}」，政治支持度下滑。`,
    linkPath: "/game/politics",
  });
}

/** Task #127 — 政體變更（主動改制達成，或政變被動更替）。 */
export function notifyGovernmentChange(params: {
  discordUserId: string;
  fromGovernment: string | null;
  toGovernment: string;
  viaCoup: boolean;
}): void {
  const from = params.fromGovernment ?? "原政體";
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.viaCoup ? "政體遭政變更替" : "政體變更",
    body: params.viaCoup
      ? `🔥 政變之後，你的國家政體由「${from}」更替為「${params.toGovernment}」。`
      : `🏛️ 在民意推動下，你的國家政體由「${from}」和平改制為「${params.toGovernment}」。`,
    linkPath: "/game/politics",
  });
}

/** 財政政策判定結果（Task #117）。body 帶入玩家原始想法摘要，方便對照。 */
export function notifyFiscalPolicyJudged(params: {
  discordUserId: string;
  title: string;
  /** 玩家當初提出的財政政策原文。 */
  idea: string;
  isGood: boolean;
}): void {
  const ideaChars = Array.from(params.idea.trim());
  const excerpt =
    ideaChars.length > 60
      ? `${ideaChars.slice(0, 60).join("")}…`
      : ideaChars.join("");
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "politics",
    title: params.isGood ? "財政政策推行成功" : "財政政策推行受挫",
    body: params.isGood
      ? `💰 你提出的財政政策「${excerpt}」順利推行——「${params.title}」，國庫與民心受益。`
      : `📉 你提出的財政政策「${excerpt}」推行受挫——「${params.title}」，國家蒙受損失。`,
    linkPath: "/game/economy",
  });
}

// ── Task #333 超事件系統 ───────────────────────────────────────

/** 超事件爆發／發展／結束／科技突破通知（站內鈴鐺）。 */
export function notifySuperEvent(params: {
  discordUserId: string;
  eventId: string;
  title: string;
  kind: "created" | "update" | "ended" | "tech" | "response";
  detail: string;
}): void {
  const titles: Record<typeof params.kind, string> = {
    created: `超事件爆發：${params.title}`,
    update: `超事件進展：${params.title}`,
    ended: `超事件落幕：${params.title}`,
    tech: `科技突破：${params.title}`,
    response: `應對判定：${params.title}`,
  };
  const icons: Record<typeof params.kind, string> = {
    created: "⚡",
    update: "🌐",
    ended: "🏁",
    tech: "💡",
    response: "📨",
  };
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "world",
    title: titles[params.kind],
    body: `${icons[params.kind]} ${params.detail}`,
    linkPath: `/game/super-events`,
  });
}

// ── Task #105 戰爭戰役 ─────────────────────────────────────────

/** 戰役開打：通知防守方（含 NPC 主動開戰時通知玩家）。 */
export function notifyCampaignStarted(params: {
  discordUserId: string;
  opponentName: string;
  regionName: string;
  campaignId: number;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "戰役爆發！",
    body: `⚔️ 「${params.opponentName}」對你控制的「${params.regionName}」發起戰役！前往戰情室部署軍團、下達指令。`,
    linkPath: `/game/military/war/${params.campaignId}`,
  });
}

/** 每次結算完成：雙方都收到戰報通知。 */
export function notifyCampaignReport(params: {
  discordUserId: string;
  regionName: string;
  cycleNumber: number;
  campaignId: number;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: `戰報：${params.regionName}戰役（第 ${params.cycleNumber} 次結算）`,
    body: `📋 「${params.regionName}」戰役完成一次結算，前往戰情室查看戰報與最新戰況。`,
    linkPath: `/game/military/war/${params.campaignId}`,
  });
}

/** Task #547 — 戰爭指令被 AI 審查標旗：反噬懲罰已於本次結算套用。 */
export function notifyWarOrderBacklash(params: {
  discordUserId: string;
  regionName: string;
  campaignId: number;
  reason: string;
  detail: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "戰爭指令濫用懲罰",
    body: `⚠️ 你在「${params.regionName}」戰役的指令被判定為濫用（${params.reason}），本次結算已套用反噬懲罰：${params.detail}。請改用合理的戰場指令。`,
    linkPath: `/game/military/war/${params.campaignId}`,
  });
}

/** Task #547 — 管理員對單筆濫用紀錄執行逐案加重處罰。 */
export function notifyAbusePunished(params: {
  discordUserId: string;
  detail: string;
  note: string | null;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "濫用行為加重處罰",
    body: `🚫 管理員已對你的濫用行為執行加重處罰：${params.detail}。${params.note ? `備註：${params.note}` : ""}`,
    linkPath: "/game",
  });
}

/** Task #453 — 有國家晚加入戰役選邊參戰：通知既有參戰玩家。 */
export function notifyCampaignJoined(params: {
  discordUserId: string;
  joinerName: string;
  sideLabel: string;
  regionName: string;
  campaignId: number;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "戰役新增參戰國",
    body: `⚔️ 「${params.joinerName}」加入「${params.regionName}」戰役的${params.sideLabel}！前往戰情室查看最新戰況。`,
    linkPath: `/game/military/war/${params.campaignId}`,
  });
}

/** Task #453 — 晚加入者因資格戰爭結束被自動退出戰役。 */
export function notifyCampaignAutoExit(params: {
  discordUserId: string;
  regionName: string;
  campaignId: number;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "已自動退出戰役",
    body: `🏳️ 你參戰資格所繫的戰爭已結束，已自動退出「${params.regionName}」戰役；前線倖存部隊與傷兵已返國。`,
    linkPath: `/game/military`,
  });
}

/** 對方提出停戰提案。 */
export function notifyCeasefireProposed(params: {
  discordUserId: string;
  opponentName: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "收到停戰提案",
    body: `🕊️ 「${params.opponentName}」提出停戰。前往外交頁面接受後，戰爭與所有進行中的戰役將即刻結束。`,
    linkPath: "/game/diplomacy",
  });
}

/** 對方接受了我方的停戰提案（戰爭結束）。 */
export function notifyCeasefireAccepted(params: {
  discordUserId: string;
  opponentName: string;
}): void {
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: "停戰成立",
    body: `🕊️ 「${params.opponentName}」接受了你的停戰提案，戰爭結束，所有進行中的戰役已終止。`,
    linkPath: "/game/diplomacy",
  });
}

/** 戰役結束：雙方各自收到結果通知。 */
export function notifyCampaignEnded(params: {
  discordUserId: string;
  regionName: string;
  campaignId: number;
  outcome: "victory" | "defeat" | "ceasefire" | "ended";
}): void {
  const titles: Record<typeof params.outcome, string> = {
    victory: "戰役勝利！",
    defeat: "戰役落敗",
    ceasefire: "戰役因停戰結束",
    ended: "戰役結束",
  };
  const bodies: Record<typeof params.outcome, string> = {
    victory: `🎖️ 「${params.regionName}」戰役以我方勝利告終！前往戰情室查看最終戰報。`,
    defeat: `🏳️ 「${params.regionName}」戰役以我方失利告終。前往戰情室查看最終戰報。`,
    ceasefire: `🕊️ 雙方停戰，「${params.regionName}」戰役即刻終止。`,
    ended: `「${params.regionName}」戰役已結束。前往戰情室查看最終戰報。`,
  };
  persistNotificationInBackground({
    discordUserId: params.discordUserId,
    type: "military",
    title: titles[params.outcome],
    body: bodies[params.outcome],
    linkPath: `/game/military/war/${params.campaignId}`,
  });
}
