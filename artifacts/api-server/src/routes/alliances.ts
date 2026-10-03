import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  alliancesTable,
  allianceInvitesTable,
  type PlayerNation,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { requireSuzerainConsent } from "../lib/vassalConsent";
import {
  ALLIANCE_NAME_MAX,
  isValidAllianceName,
  allianceNameTaken,
  createAlliance,
  renameAlliance,
  disbandAlliance,
  leaveAlliance,
  kickMember,
  inviteToAlliance,
  applyToAlliance,
  respondToInvite,
  respondToApplication,
  listAlliancesWithMembers,
  getMyAllianceContext,
  getNationAllianceIds,
} from "../lib/alliances";
import {
  notifyAllianceInvited,
  notifyAllianceApplicationReceived,
  notifyAllianceApplicationApproved,
  notifyAllianceKicked,
  notifyAllianceDisbanded,
} from "../lib/diplomacyNotify";

/**
 * Task #215 — 具名多國聯盟的玩家端點。
 * 讀取聯盟世界列表為公開（不需登入）；其餘操作皆為 session 閘門、繁體中文錯誤。
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

/** 依 nationId 查該國的 Discord 帳號（通知用）。 */
async function discordIdOf(nationId: string): Promise<string | null> {
  const [row] = await db
    .select({ discordUserId: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  return row?.discordUserId ?? null;
}

// ── 公開：世界聯盟列表 ─────────────────────────────────────────────
router.get("/alliances", async (req, res) => {
  const alliances = await listAlliancesWithMembers();
  // 若已登入且已建國，附上我方所屬的所有聯盟 id（方便前端標示；多聯盟制）。
  let myAllianceIds: string[] = [];
  const session = await getSession(readSessionToken(req));
  if (session) {
    const [nation] = await db
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.discordUserId, session.discordUserId))
      .limit(1);
    if (nation) myAllianceIds = await getNationAllianceIds(nation.id);
  }
  res.json({ alliances, myAllianceIds });
});

// ── 我的聯盟總覽 ───────────────────────────────────────────────────
router.get("/alliance/mine", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const ctx = await getMyAllianceContext(auth.nation.id);
  res.json(ctx);
});

// ── 建立聯盟 ───────────────────────────────────────────────────────
router.post("/alliances", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const name = (req.body as { name?: unknown })?.name;
  if (!isValidAllianceName(name)) {
    res
      .status(400)
      .json({ error: `聯盟名稱需為 1 至 ${ALLIANCE_NAME_MAX} 字` });
    return;
  }
  // 先行重名檢查：避免在必然 409 的情況下白白消耗一次性宗主批准
  // （權威檢查仍在 createAlliance 交易內，競態時最多重新請求一次批准）。
  if (await allianceNameTaken(name)) {
    res.status(409).json({ error: "已有同名聯盟" });
    return;
  }
  // 附庸外交受限：附庸建立聯盟需宗主同意。
  const consent = await requireSuzerainConsent({
    vassalNationId: auth.nation.id,
    vassalName: auth.nation.name,
    actionType: "alliance_create",
    subjectName: name,
  });
  if (!consent.ok) {
    res.status(consent.status).json({ error: consent.error });
    return;
  }
  const result = await createAlliance(auth.nation.id, name);
  if (!result.ok) {
    res.status(409).json({ error: "已有同名聯盟" });
    return;
  }
  res.status(201).json({ alliance: result.alliance });
});

// ── 改名 ───────────────────────────────────────────────────────────
router.patch("/alliances/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const name = (req.body as { name?: unknown })?.name;
  if (!isValidAllianceName(name)) {
    res
      .status(400)
      .json({ error: `聯盟名稱需為 1 至 ${ALLIANCE_NAME_MAX} 字` });
    return;
  }
  const result = await renameAlliance(req.params.id, auth.nation.id, name);
  if (!result.ok) {
    if (result.code === "not_found") {
      res.status(404).json({ error: "找不到這個聯盟" });
      return;
    }
    if (result.code === "not_founder") {
      res.status(403).json({ error: "只有聯盟創始國可以改名" });
      return;
    }
    res.status(409).json({ error: "已有同名聯盟" });
    return;
  }
  res.json({ alliance: result.alliance });
});

// ── 解散 ───────────────────────────────────────────────────────────
router.delete("/alliances/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const result = await disbandAlliance(req.params.id, auth.nation.id);
  if (!result.ok) {
    if (result.code === "not_found") {
      res.status(404).json({ error: "找不到這個聯盟" });
      return;
    }
    res.status(403).json({ error: "只有聯盟創始國可以解散聯盟" });
    return;
  }
  notifyAllianceDisbanded({
    memberNationIds: result.memberNationIds,
    allianceName: result.allianceName,
  });
  res.json({ ok: true });
});

// ── 邀請國家加入 ───────────────────────────────────────────────────
router.post("/alliances/:id/invite", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const targetNationId = (req.body as { targetNationId?: unknown })
    ?.targetNationId;
  if (typeof targetNationId !== "string" || !targetNationId) {
    res.status(400).json({ error: "請指定要邀請的國家" });
    return;
  }
  const result = await inviteToAlliance(
    req.params.id,
    auth.nation.id,
    targetNationId,
  );
  if (!result.ok) {
    const map: Record<string, [number, string]> = {
      not_found: [404, "找不到這個聯盟"],
      not_founder: [403, "只有聯盟創始國可以邀請"],
      already_member: [409, "該國家已是本聯盟成員"],
      duplicate: [409, "已有待回覆的邀請"],
    };
    const [status, error] = map[result.code] ?? [409, "邀請失敗"];
    res.status(status).json({ error });
    return;
  }
  const targetDiscordUserId = await discordIdOf(targetNationId);
  notifyAllianceInvited({
    targetDiscordUserId,
    allianceName: result.allianceName,
  });
  res.status(201).json({ ok: true });
});

// ── 申請加入聯盟 ───────────────────────────────────────────────────
router.post("/alliances/:id/apply", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  // 附庸外交受限：附庸申請加入聯盟需宗主同意。
  // 聯盟不存在 → 先回 404，確保進入守門時 allianceId 一定有值
  // （消耗批准的比對條件才不會退化成「任一聯盟」）。
  const [allianceRow] = await db
    .select({ name: alliancesTable.name })
    .from(alliancesTable)
    .where(eq(alliancesTable.id, req.params.id))
    .limit(1);
  if (!allianceRow) {
    res.status(404).json({ error: "找不到這個聯盟" });
    return;
  }
  const consent = await requireSuzerainConsent({
    vassalNationId: auth.nation.id,
    vassalName: auth.nation.name,
    actionType: "alliance_join",
    allianceId: req.params.id,
    subjectName: allianceRow.name,
  });
  if (!consent.ok) {
    res.status(consent.status).json({ error: consent.error });
    return;
  }
  const result = await applyToAlliance(req.params.id, auth.nation.id);
  if (!result.ok) {
    const map: Record<string, [number, string]> = {
      not_found: [404, "找不到這個聯盟"],
      not_founder: [403, "無法申請"],
      already_member: [409, "你已是本聯盟成員"],
      duplicate: [409, "已有待核准的申請"],
    };
    const [status, error] = map[result.code] ?? [409, "申請失敗"];
    res.status(status).json({ error });
    return;
  }
  // 通知聯盟創始國。
  const all = await listAlliancesWithMembers();
  const alliance = all.find((a) => a.id === req.params.id);
  if (alliance?.founderNationId) {
    notifyAllianceApplicationReceived({
      founderNationId: alliance.founderNationId,
      applicantNationName: auth.nation.name,
      allianceName: result.allianceName,
    });
  }
  res.status(201).json({ ok: true });
});

// ── 回覆聯盟邀請（受邀國）───────────────────────────────────────────
router.post("/alliance-invites/:id/respond", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const inviteId = Number(req.params.id);
  const accept = (req.body as { accept?: unknown })?.accept === true;
  if (!Number.isInteger(inviteId)) {
    res.status(400).json({ error: "邀請 id 不正確" });
    return;
  }
  // 附庸外交受限：附庸「接受」聯盟邀請＝加入聯盟，需宗主同意（婉拒不用）。
  if (accept) {
    const [invite] = await db
      .select({
        allianceId: allianceInvitesTable.allianceId,
        allianceName: alliancesTable.name,
      })
      .from(allianceInvitesTable)
      .innerJoin(
        alliancesTable,
        eq(allianceInvitesTable.allianceId, alliancesTable.id),
      )
      .where(
        and(
          eq(allianceInvitesTable.id, inviteId),
          eq(allianceInvitesTable.status, "pending"),
        ),
      )
      .limit(1);
    if (invite) {
      const consent = await requireSuzerainConsent({
        vassalNationId: auth.nation.id,
        vassalName: auth.nation.name,
        actionType: "alliance_join",
        allianceId: invite.allianceId,
        subjectName: invite.allianceName,
      });
      if (!consent.ok) {
        res.status(consent.status).json({ error: consent.error });
        return;
      }
    }
  }
  const result = await respondToInvite(inviteId, auth.nation.id, accept);
  if (!result.ok) {
    if (result.code === "already_member") {
      res.status(409).json({ error: "你已是該聯盟成員" });
      return;
    }
    res.status(404).json({ error: "找不到這個邀請" });
    return;
  }
  res.json({ ok: true, joined: result.joined });
});

// ── 回覆入盟申請（創始國核准／婉拒）─────────────────────────────────
router.post("/alliance-applications/:id/respond", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const inviteId = Number(req.params.id);
  const accept = (req.body as { accept?: unknown })?.accept === true;
  if (!Number.isInteger(inviteId)) {
    res.status(400).json({ error: "申請 id 不正確" });
    return;
  }
  const result = await respondToApplication(inviteId, auth.nation.id, accept);
  if (!result.ok) {
    if (result.code === "not_founder") {
      res.status(403).json({ error: "只有聯盟創始國可以核准申請" });
      return;
    }
    if (result.code === "already_member") {
      res.status(409).json({ error: "申請國已是該聯盟成員" });
      return;
    }
    res.status(404).json({ error: "找不到這個申請" });
    return;
  }
  if (result.approved) {
    notifyAllianceApplicationApproved({
      applicantNationId: result.applicantNationId,
      allianceName: result.allianceName,
    });
  }
  res.json({ ok: true, approved: result.approved });
});

// ── 退出聯盟（多聯盟制：需指定要退出哪個聯盟）─────────────────────
router.post("/alliance/leave", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const allianceId = (req.body as { allianceId?: unknown })?.allianceId;
  if (typeof allianceId !== "string" || !allianceId) {
    res.status(400).json({ error: "請指定要退出的聯盟" });
    return;
  }
  const result = await leaveAlliance(auth.nation.id, allianceId);
  if (!result.ok) {
    res.status(400).json({ error: "你的國家不是該聯盟成員" });
    return;
  }
  res.json({ ok: true, disbanded: result.disbanded });
});

// ── 踢除成員 ───────────────────────────────────────────────────────
router.post("/alliances/:id/kick", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const targetNationId = (req.body as { targetNationId?: unknown })
    ?.targetNationId;
  if (typeof targetNationId !== "string" || !targetNationId) {
    res.status(400).json({ error: "請指定要移除的成員" });
    return;
  }
  const result = await kickMember(req.params.id, auth.nation.id, targetNationId);
  if (!result.ok) {
    const map: Record<string, [number, string]> = {
      not_found: [404, "找不到這個聯盟"],
      not_founder: [403, "只有聯盟創始國可以移除成員"],
      not_member: [404, "該國家不是聯盟成員"],
      cannot_kick_self: [400, "創始國無法移除自己，請改用退出或解散"],
    };
    const [status, error] = map[result.code] ?? [409, "移除失敗"];
    res.status(status).json({ error });
    return;
  }
  notifyAllianceKicked({
    targetNationId,
    allianceName: result.allianceName,
  });
  res.json({ ok: true });
});

export default router;
