import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  type MilitaryTechBonus,
  type PlayerNation,
  type ProductionTechEffect,
  type SocialTechEffect,
  type TechTreeDomain,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import { TECH_TREE_DOMAIN_LABELS } from "../lib/techTree";
import { getEraSlugs } from "../lib/nationStats";
import { describeSocialEffect } from "../lib/socialTech";
import { describeProductionEffect } from "../lib/production";
import { describeMilitaryBonus } from "../lib/military";
import {
  allKeyTechsOf,
  keyTechsUnlockedByEra,
  normalizeEra,
} from "../lib/eraUnlockedTech";

/**
 * Task #469 — 全球統一線性科技樹玩家路由（Discord session 閘門，進 OpenAPI spec）。
 *
 * - GET  /tech-tree/overview   三領域科技樹總覽（節點狀態、進行中、分配比例）。
 * - POST /tech-tree/research   選定節點開始研發（成本快照鎖定）。
 * - POST /tech-tree/cancel     取消該領域進行中研發（進度作廢）。
 * - PUT  /tech-tree/allocation 設定三領域科研點數分配比例（整數 %、合計 100）。
 */

const router: IRouter = Router();

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

function eraLabel(slug: string): string {
  return ERAS[getEraIndex(slug)]?.label ?? slug;
}

const GONE_MESSAGE =
  "科技樹已下線:關鍵技術改為隨世界時代自動解鎖,不需要也無法再研發";

/** 單一效果轉成 zh-TW 顯示文字。 */
function effectLabel(domain: TechTreeDomain, eff: unknown): string {
  if (domain === "social") return describeSocialEffect(eff as SocialTechEffect);
  if (domain === "production") {
    return describeProductionEffect(eff as ProductionTechEffect);
  }
  return describeMilitaryBonus(eff as MilitaryTechBonus);
}

/**
 * 三領域「年代解鎖一覽」。
 *
 * 科技樹已下線:關鍵技術改依世界時代自動解鎖,不再有研發。回應形狀沿用舊
 * TechTreeOverview(前端與 OpenAPI 相容),內容則是:
 * - 每領域只列關鍵技術,世界時代(含)以內者 status="researched",之後者
 *   status="locked" 並註明解鎖年代;
 * - 沒有進行中研發、分配比例固定 0、每回合點數 0。
 */
router.get("/tech-tree/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const { currentEra } = await getEraSlugs();
  const worldEra = normalizeEra(currentEra);
  const worldIdx = getEraIndex(worldEra);

  const domains = (["social", "production", "military"] as const).map(
    (domain) => {
      const unlocked = new Set(
        keyTechsUnlockedByEra(domain, worldEra).map((k) => k.keySlug),
      );
      const all = allKeyTechsOf(domain);
      return {
        domain,
        domainLabel: TECH_TREE_DOMAIN_LABELS[domain],
        eraSlug: worldEra,
        eraLabel: eraLabel(worldEra),
        ratioPct: 0,
        perTurnPoints: 0,
        active: null,
        nodes: all.map((k, i) => {
          const isOpen = unlocked.has(k.keySlug);
          return {
            id: -(i + 1),
            eraSlug: k.eraSlug,
            eraLabel: eraLabel(k.eraSlug),
            lineKey: "key",
            lineLabel: "關鍵技術",
            lineKind: "main",
            sortOrder: i + 1,
            branchFromNodeId: null,
            name: k.name,
            description: k.description,
            keySlug: k.keySlug,
            isKey: true,
            costPoints: 0,
            effects: k.effects.map((e) => effectLabel(domain, e)),
            status: isOpen ? "researched" : "locked",
            lockedReason: isOpen
              ? null
              : `世界進入「${eraLabel(k.eraSlug)}」時自動解鎖`,
          };
        }),
      };
    },
  );
  void worldIdx;

  res.json({
    techGainPerTurn: 0,
    stockTechPoints: Math.max(0, nation.techPoints),
    allocation: { social: 0, production: 0, military: 0 },
    domains,
  });
});

/** 選定節點開始研發。 */
router.post("/tech-tree/research", (_req, res) => {
  res.status(410).json({ error: GONE_MESSAGE });
});

/** 取消該領域進行中研發（進度作廢）。 */
router.post("/tech-tree/cancel", (_req, res) => {
  res.status(410).json({ error: GONE_MESSAGE });
});

/** 設定三領域科研點數分配比例。 */
router.put("/tech-tree/allocation", (_req, res) => {
  res.status(410).json({ error: GONE_MESSAGE });
});

export default router;
