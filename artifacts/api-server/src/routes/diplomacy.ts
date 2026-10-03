import { Router, type IRouter } from "express";
import nationsRouter from "./diplomacy/nations";
import messagesRouter from "./diplomacy/messages";
import lobbyRouter from "./diplomacy/lobby";
import treatiesRouter from "./diplomacy/treaties";
import treatyLifecycleRouter from "./diplomacy/treatyLifecycle";
import relationsRouter from "./diplomacy/relations";
import warsRouter from "./diplomacy/wars";
import consentsRouter from "./diplomacy/consents";

/**
 * Task #34 — 外交系統玩家端點（皆為 session 閘門、繁體中文錯誤訊息）。
 * 國家目錄／通訊／交流（親善）／締約／宣戰。
 */
const router: IRouter = Router();

// ── 國家目錄（距離排序＋搜尋） ─────────────────────────────────
router.use(nationsRouter);

// ── 通訊（玩家聊天） ───────────────────────────────────────────
router.use(messagesRouter);

// ── 玩家大廳（所有玩家共用的群聊） ─────────────────────────────
router.use(lobbyRouter);

// Task #228 — 移除固定親善操作（送禮／派駐大使館／污辱）。
// 玩家與 NPC 的關係值改由 AI 於對話／條約談判時判定（每次 −20～+20）；
// 玩家↔玩家不再有關係值。原 POST /diplomacy/relations/:nationId/action 端點已刪除。

// ── 締約 ───────────────────────────────────────────────────────
router.use(treatiesRouter);
router.use(treatyLifecycleRouter);

// ── NPC 提案記憶（Task #90）／近期互動紀錄（Task #92） ─────────
router.use(relationsRouter);

// ── 宣戰 ───────────────────────────────────────────────────────
router.use(warsRouter);
router.use(consentsRouter);

export { __resetLobbyPostCooldownForTests } from "./diplomacy/lobby";
export default router;
