import { eq } from "drizzle-orm";
import {
  db,
  superEventsTable,
  techTreeNodesTable,
  playerResearchedTreeNodesTable,
  type SuperEvent,
  type SuperEventGrantedTech,
} from "@workspace/db";
import { ERAS, getEraIndex } from "../mapRegionEras";
import { judgeSuperEventTurn, clampTechBonuses } from "../superEventAi";
import { notifySuperEvent, notifyMilitaryResearchComplete } from "../gameNotify";
import { executeNpcChatActions } from "../npcChatActionExecutor";
import type { PlannedChatAction } from "../npcChatActions";
import { logger } from "../logger";
import type { AffectedNation } from "./types";

/**
 * 賦予一則跨時代關鍵科技給所有受影響的玩家（NPC 不需要）。回傳是否賦予。
 *
 * Task #469 起科技樹統一：超事件科技以 lineKind = "event" 的特殊節點寫入
 * tech_tree_nodes（不掛任何線、computeNodeStatuses 永遠鎖定 → 玩家無法自行
 * 研發，只能由事件授予），再插入 player_researched_tree_nodes。
 */
export async function grantCrossEraTech(
  event: SuperEvent,
  affected: AffectedNation[],
  grant: NonNullable<Awaited<ReturnType<typeof judgeSuperEventTurn>>["grantTech"]>,
  currentEra: string,
): Promise<boolean> {
  // 去重：同一事件不重複賦予同名科技。
  const already = event.grantedTechs.some((g) => g.name === grant.name);
  if (already) return false;

  const players = affected.filter((n) => !n.isNpc && n.discordUserId);
  if (players.length === 0) return false;

  const eraSlug = ERAS[getEraIndex(grant.era)]?.slug ?? currentEra;
  const nameSlug = grant.name.trim().toLowerCase().replace(/\s+/g, "-");
  const keySlug = `super-event:${event.id}:${nameSlug}`;

  // 建立（或重用）科技樹節點（keySlug 唯一去重）。
  let [node] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.keySlug, keySlug))
    .limit(1);
  if (!node) {
    const inserted = await db
      .insert(techTreeNodesTable)
      .values({
        domain: "military",
        eraSlug,
        lineKey: `super-event-${event.id}`,
        lineLabel: "超事件科技",
        lineKind: "event",
        sortOrder: 1,
        name: grant.name,
        description: grant.description,
        baseCost: 0,
        effects: clampTechBonuses(grant.bonuses),
        keySlug,
      })
      .onConflictDoNothing({ target: techTreeNodesTable.keySlug })
      .returning({ id: techTreeNodesTable.id });
    node = inserted[0];
    if (!node) {
      [node] = await db
        .select({ id: techTreeNodesTable.id })
        .from(techTreeNodesTable)
        .where(eq(techTreeNodesTable.keySlug, keySlug))
        .limit(1);
    }
  }
  if (!node) return false;
  const nodeId = node.id;

  for (const p of players) {
    try {
      await db
        .insert(playerResearchedTreeNodesTable)
        .values({ nationId: p.id, nodeId })
        .onConflictDoNothing({
          target: [
            playerResearchedTreeNodesTable.nationId,
            playerResearchedTreeNodesTable.nodeId,
          ],
        });
      notifyMilitaryResearchComplete({
        discordUserId: p.discordUserId!,
        techName: grant.name,
      });
      notifySuperEvent({
        discordUserId: p.discordUserId!,
        eventId: event.id,
        title: grant.name,
        kind: "tech",
        detail: `「${event.title}」帶來跨時代科技突破——「${grant.name}」已納入你的科技，軍事加成即刻生效。`,
      });
    } catch (err) {
      logger.error(
        { err, eventId: event.id, nodeId },
        "super event tech grant to player failed",
      );
    }
  }

  const merged: SuperEventGrantedTech[] = [
    ...event.grantedTechs,
    { keySlug, name: grant.name, era: eraSlug },
  ];
  await db
    .update(superEventsTable)
    .set({ grantedTechs: merged })
    .where(eq(superEventsTable.id, event.id));
  event.grantedTechs = merged;
  return true;
}

/**
 * NPC 敵對行動：讓一個受影響的 NPC 對一個受影響的真實玩家宣戰／出兵。委派給
 * executeNpcChatActions（既有寫入層再次把關所有硬性條件，NPC↔NPC 一律被擋）。
 * best-effort：無合法對象時為 no-op，失敗只記 log。
 */
export async function triggerNpcHostility(
  event: SuperEvent,
  affected: AffectedNation[],
  aggressive: boolean,
): Promise<void> {
  const players = affected.filter((n) => !n.isNpc && n.discordUserId);
  const npcs = affected.filter((n) => n.isNpc);
  if (players.length === 0 || npcs.length === 0) return;

  const actor = npcs[Math.floor(Math.random() * npcs.length)]!;
  const target = players[Math.floor(Math.random() * players.length)]!;
  const planned: PlannedChatAction[] = [
    {
      type: aggressive ? "declare_war" : "propose_treaty",
      targetId: target.id,
      targetIsPlayer: true,
      treatyType: aggressive ? null : "nonaggression",
      durationDays: null,
      offerMoney: 0,
      offerTechPoints: 0,
      offerRegionIds: [],
      clause: null,
      demandMoney: 0,
      demandTechPoints: 0,
      demandRegions: [],
    },
  ];
  try {
    await executeNpcChatActions({
      actorId: actor.id,
      counterpartId: target.id,
      planned,
    });
  } catch (err) {
    logger.error(
      { err, eventId: event.id },
      "super event NPC hostility action failed",
    );
  }
}
