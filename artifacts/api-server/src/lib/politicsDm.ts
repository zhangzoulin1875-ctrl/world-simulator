import { deliverPoliticsDm } from "./diplomacyNotify";
import { logger } from "./logger";

/**
 * Task #55 — 內政結算結果 Discord 私訊摘要。
 *
 * 每國結算完成後，把該回合發生的事（政策成功/失敗、隨機事件、政變）
 * 彙整成「一則」zh-TW 私訊摘要，透過 diplomacyNotify 的 deliverPoliticsDm gate
 * 送出（尊重 dm_politics_enabled「內政私訊」開關 — 玩家可在遊戲設定中關閉；
 * 與外交私訊開關各自獨立）。
 * 什麼都沒發生（buildPoliticsSettlementDm 回傳 null）就不打擾玩家。
 * 私訊一律 fire-and-forget：失敗只記 log，絕不影響結算主流程。
 * 站內鈴鐺通知照舊由 gameNotify.ts 逐事件寫入，與本摘要互不影響。
 */

// ── 純函式（單元測試） ─────────────────────────────────────────

/** 單一國家在本回合結算中發生的事件彙整。 */
export interface PoliticsNationDigest {
  nationName: string | null;
  /** 已判定的政策想法結果（依判定順序）。 */
  policies: Array<{ title: string; succeeded: boolean }>;
  /** 本回合觸發的隨機事件（無則 null）。 */
  event: { title: string; good: boolean } | null;
  /** 本回合爆發的政變（無則 null）。 */
  coup: { title: string } | null;
}

export function emptyPoliticsDigest(
  nationName: string | null,
): PoliticsNationDigest {
  return { nationName, policies: [], event: null, coup: null };
}

/** 網站內政頁完整網址；SITE_URL 優先，否則用 REPLIT_DOMAINS 第一個網域。 */
export function politicsSiteUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const site = env["SITE_URL"]?.trim();
  if (site) return `${site.replace(/\/+$/, "")}/game/politics`;
  const first = env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
  if (first) return `https://${first}/game/politics`;
  return null;
}

/**
 * 把 digest 組成一則私訊摘要；本回合什麼都沒發生時回傳 null（不發訊）。
 */
export function buildPoliticsSettlementDm(
  digest: PoliticsNationDigest,
  url: string | null,
): string | null {
  const lines: string[] = [];
  for (const p of digest.policies) {
    lines.push(
      p.succeeded
        ? `📜 政策「${p.title}」推行成功，已正式生效。`
        : `📉 政策「${p.title}」推行失敗，國家蒙受損失。`,
    );
  }
  if (digest.event) {
    lines.push(
      `${digest.event.good ? "🎉" : "🌩️"} 隨機事件：「${digest.event.title}」。`,
    );
  }
  if (digest.coup) {
    lines.push(
      `🔥 政變爆發：「${digest.coup.title}」— 政局重置：滿意度、穩定度與支持度回到原點，短期內無法推行政策與設計兵種，軍隊士氣暫時低落！`,
    );
  }
  if (lines.length === 0) return null;

  const name = digest.nationName?.trim() || "你的國家";
  const parts = [`🏛️ 「${name}」內政回合結算結果：`, ...lines];
  if (url) parts.push(`👉 前往內政頁面：${url}`);
  return parts.join("\n");
}

// ── DM 發送（fire-and-forget） ─────────────────────────────────

/**
 * 結算完成後發送摘要私訊。走 deliverPoliticsDm 的 opt-out gate（內政私訊開關）；
 * 任何錯誤（bot 離線、對方關閉 DM 的 50007）只記 log。
 */
export function sendPoliticsSettlementDm(
  discordUserId: string,
  digest: PoliticsNationDigest,
): void {
  const content = buildPoliticsSettlementDm(digest, politicsSiteUrl());
  if (!content) return;
  deliverPoliticsDm(discordUserId, content).catch((err) => {
    logger.warn(
      { err, discordUserId },
      "politics settlement DM failed (recipient may have DMs disabled)",
    );
  });
}
