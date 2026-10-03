import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  alliancesTable,
  allianceMembersTable,
  allianceInvitesTable,
  playerNationsTable,
  type Alliance,
} from "@workspace/db";
import { ALLIANCE_LOCK_NS } from "./locks";
import { pgErrorCode } from "./playerValidation";

/**
 * Task #215 — 具名多國聯盟的資料層（純函式 + 交易操作）。
 *
 * 不變量：一國可同時加入「多個」聯盟，但同一聯盟不可重複加入
 * （由 alliance_members (alliance_id, nation_id) 唯一索引保證）。
 * 併發下的加入以 pg_advisory_xact_lock 對涉及國家序列化，並在唯一違反時回乾淨的
 * "already_member"／"duplicate" 結果（walks cause chain 的 pgErrorCode）。
 *
 * 語意：只要兩國「有任一共同聯盟」即不可互相宣戰（見 nationsInSameAlliance，
 * 供宣戰路由使用），但成員「不」自動參戰（自動參戰只保留給保障獨立條約）。
 */

export const ALLIANCE_NAME_MAX = 40;

/** 純函式：聯盟名稱是否合法（去頭尾空白後 1..ALLIANCE_NAME_MAX 字）。 */
export function isValidAllianceName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= ALLIANCE_NAME_MAX
  );
}

/**
 * 純函式：兩組聯盟 id 是否有交集（任一共同聯盟）。
 * 供宣戰阻擋使用（同盟成員不可互相宣戰）。
 */
export function haveCommonAlliance(
  aAllianceIds: readonly string[],
  bAllianceIds: readonly string[],
): boolean {
  if (aAllianceIds.length === 0 || bAllianceIds.length === 0) return false;
  const set = new Set(aAllianceIds);
  return bAllianceIds.some((id) => set.has(id));
}

/** 純函式：預設聯盟名稱（以創始國名生成）。 */
export function defaultAllianceName(founderName: string | null): string {
  const base = (founderName ?? "無名國").trim() || "無名國";
  const name = `${base}聯盟`;
  return name.length <= ALLIANCE_NAME_MAX
    ? name
    : name.slice(0, ALLIANCE_NAME_MAX);
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DbTransaction;

/** 查詢某國家目前所屬的所有聯盟 id（依加入時間排序；無則空陣列）。 */
export async function getNationAllianceIds(
  nationId: string,
  executor: Executor = db,
): Promise<string[]> {
  const rows = await executor
    .select({ allianceId: allianceMembersTable.allianceId })
    .from(allianceMembersTable)
    .where(eq(allianceMembersTable.nationId, nationId))
    .orderBy(asc(allianceMembersTable.joinedAt), asc(allianceMembersTable.id));
  return rows.map((r) => r.allianceId);
}

/** 某國家是否已是某聯盟成員。 */
async function isAllianceMember(
  allianceId: string,
  nationId: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: allianceMembersTable.id })
    .from(allianceMembersTable)
    .where(
      and(
        eq(allianceMembersTable.allianceId, allianceId),
        eq(allianceMembersTable.nationId, nationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** 兩國是否有任一共同聯盟（宣戰阻擋用）。 */
export async function nationsInSameAlliance(
  a: string,
  b: string,
): Promise<boolean> {
  const rows = await db
    .select({
      nationId: allianceMembersTable.nationId,
      allianceId: allianceMembersTable.allianceId,
    })
    .from(allianceMembersTable)
    .where(
      sql`${allianceMembersTable.nationId} IN (${a}::uuid, ${b}::uuid)`,
    );
  const aIds: string[] = [];
  const bIds: string[] = [];
  for (const r of rows) {
    if (r.nationId === a) aIds.push(r.allianceId);
    if (r.nationId === b) bIds.push(r.allianceId);
  }
  return haveCommonAlliance(aIds, bIds);
}

async function lockNation(tx: Executor, nationId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ALLIANCE_LOCK_NS}, hashtext(${nationId}))`,
  );
}

/** 名稱是否已被其他聯盟使用（不分大小寫；best-effort，非資料庫層唯一）。 */
async function nameTaken(
  tx: Executor,
  name: string,
  excludeAllianceId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: alliancesTable.id })
    .from(alliancesTable)
    .where(
      excludeAllianceId
        ? and(
            sql`lower(${alliancesTable.name}) = lower(${name.trim()})`,
            ne(alliancesTable.id, excludeAllianceId),
          )
        : sql`lower(${alliancesTable.name}) = lower(${name.trim()})`,
    )
    .limit(1);
  return rows.length > 0;
}

// ── 建立／改名／解散 ────────────────────────────────────────────

export type CreateAllianceResult =
  | { ok: true; alliance: Alliance }
  | { ok: false; code: "duplicate_name" };

/** 路由層在消耗宗主批准前先行重名檢查用（權威檢查仍在 createAlliance 交易內）。 */
export async function allianceNameTaken(name: string): Promise<boolean> {
  return nameTaken(db, name);
}

/** 建立新聯盟（多聯盟制：已屬其他聯盟仍可另建）。 */
export async function createAlliance(
  nationId: string,
  name: string,
): Promise<CreateAllianceResult> {
  return db.transaction(async (tx) => {
    await lockNation(tx, nationId);
    if (await nameTaken(tx, name)) {
      return { ok: false as const, code: "duplicate_name" };
    }
    const [alliance] = await tx
      .insert(alliancesTable)
      .values({ name: name.trim(), founderNationId: nationId })
      .returning();
    if (!alliance) throw new Error("建立聯盟失敗");
    await tx
      .insert(allianceMembersTable)
      .values({ allianceId: alliance.id, nationId });
    return { ok: true as const, alliance };
  });
}

export type RenameAllianceResult =
  | { ok: true; alliance: Alliance }
  | { ok: false; code: "not_found" | "not_founder" | "duplicate_name" };

export async function renameAlliance(
  allianceId: string,
  actorNationId: string,
  name: string,
): Promise<RenameAllianceResult> {
  return db.transaction(async (tx) => {
    const [alliance] = await tx
      .select()
      .from(alliancesTable)
      .where(eq(alliancesTable.id, allianceId))
      .limit(1);
    if (!alliance) return { ok: false as const, code: "not_found" };
    if (alliance.founderNationId !== actorNationId) {
      return { ok: false as const, code: "not_founder" };
    }
    if (await nameTaken(tx, name, allianceId)) {
      return { ok: false as const, code: "duplicate_name" };
    }
    const [updated] = await tx
      .update(alliancesTable)
      .set({ name: name.trim() })
      .where(eq(alliancesTable.id, allianceId))
      .returning();
    return { ok: true as const, alliance: updated! };
  });
}

export type DisbandAllianceResult =
  | { ok: true; allianceName: string; memberNationIds: string[] }
  | { ok: false; code: "not_found" | "not_founder" };

export async function disbandAlliance(
  allianceId: string,
  actorNationId: string,
): Promise<DisbandAllianceResult> {
  return db.transaction(async (tx) => {
    const [alliance] = await tx
      .select()
      .from(alliancesTable)
      .where(eq(alliancesTable.id, allianceId))
      .limit(1);
    if (!alliance) return { ok: false as const, code: "not_found" };
    if (alliance.founderNationId !== actorNationId) {
      return { ok: false as const, code: "not_founder" };
    }
    const members = await tx
      .select({ nationId: allianceMembersTable.nationId })
      .from(allianceMembersTable)
      .where(eq(allianceMembersTable.allianceId, allianceId));
    // cascade 會一併刪除 members / invites。
    await tx.delete(alliancesTable).where(eq(alliancesTable.id, allianceId));
    return {
      ok: true as const,
      allianceName: alliance.name,
      memberNationIds: members
        .map((m) => m.nationId)
        .filter((id) => id !== actorNationId),
    };
  });
}

// ── 加入（邀請接受／申請核准／NPC 直接加入） ────────────────────

export type JoinAllianceResult =
  | { ok: true; allianceName: string }
  | { ok: false; code: "not_found" | "already_member" };

/**
 * 讓某國家加入既有聯盟（供 NPC 直接加入使用；玩家走 invite/apply 流程）。
 * 多聯盟制：可同時屬於多個聯盟；同一聯盟不可重複加入
 * （唯一索引保證，23505 → already_member）。
 */
export async function joinAlliance(
  allianceId: string,
  nationId: string,
): Promise<JoinAllianceResult> {
  try {
    return await db.transaction(async (tx) => {
      await lockNation(tx, nationId);
      const [alliance] = await tx
        .select({ name: alliancesTable.name })
        .from(alliancesTable)
        .where(eq(alliancesTable.id, allianceId))
        .limit(1);
      if (!alliance) return { ok: false as const, code: "not_found" };
      if (await isAllianceMember(allianceId, nationId, tx)) {
        return { ok: false as const, code: "already_member" };
      }
      await tx
        .insert(allianceMembersTable)
        .values({ allianceId, nationId });
      // 加入後只撤除「該聯盟」對該國的 pending 邀請／申請（其他聯盟不受影響）。
      await tx
        .update(allianceInvitesTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(allianceInvitesTable.allianceId, allianceId),
            eq(allianceInvitesTable.nationId, nationId),
            eq(allianceInvitesTable.status, "pending"),
          ),
        );
      return { ok: true as const, allianceName: alliance.name };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      return { ok: false, code: "already_member" };
    }
    throw err;
  }
}

// ── 退出／踢除 ──────────────────────────────────────────────────

export type LeaveAllianceResult =
  | { ok: true; disbanded: boolean; allianceId: string }
  | { ok: false; code: "not_member" };

/**
 * 退出「指定」聯盟（多聯盟制：必須指名要退出哪個聯盟）。
 * 創始國退出時：若尚有其他成員→移交給最早加入者；若已無其他成員→解散聯盟（cascade）。
 */
export async function leaveAlliance(
  nationId: string,
  allianceId: string,
): Promise<LeaveAllianceResult> {
  return db.transaction(async (tx) => {
    await lockNation(tx, nationId);
    const [membership] = await tx
      .select({ allianceId: allianceMembersTable.allianceId })
      .from(allianceMembersTable)
      .where(
        and(
          eq(allianceMembersTable.nationId, nationId),
          eq(allianceMembersTable.allianceId, allianceId),
        ),
      )
      .limit(1);
    if (!membership) return { ok: false as const, code: "not_member" };

    await tx
      .delete(allianceMembersTable)
      .where(
        and(
          eq(allianceMembersTable.nationId, nationId),
          eq(allianceMembersTable.allianceId, allianceId),
        ),
      );

    const [alliance] = await tx
      .select({ founderNationId: alliancesTable.founderNationId })
      .from(alliancesTable)
      .where(eq(alliancesTable.id, allianceId))
      .limit(1);

    const remaining = await tx
      .select({ nationId: allianceMembersTable.nationId })
      .from(allianceMembersTable)
      .where(eq(allianceMembersTable.allianceId, allianceId))
      .orderBy(asc(allianceMembersTable.joinedAt), asc(allianceMembersTable.id));

    if (remaining.length === 0) {
      await tx.delete(alliancesTable).where(eq(alliancesTable.id, allianceId));
      return { ok: true as const, disbanded: true, allianceId };
    }
    // 創始國離開 → 移交給最早加入的剩餘成員。
    if (alliance && alliance.founderNationId === nationId) {
      await tx
        .update(alliancesTable)
        .set({ founderNationId: remaining[0]!.nationId })
        .where(eq(alliancesTable.id, allianceId));
    }
    return { ok: true as const, disbanded: false, allianceId };
  });
}

export type KickMemberResult =
  | { ok: true; allianceName: string }
  | {
      ok: false;
      code: "not_found" | "not_founder" | "not_member" | "cannot_kick_self";
    };

export async function kickMember(
  allianceId: string,
  actorNationId: string,
  targetNationId: string,
): Promise<KickMemberResult> {
  return db.transaction(async (tx) => {
    const [alliance] = await tx
      .select()
      .from(alliancesTable)
      .where(eq(alliancesTable.id, allianceId))
      .limit(1);
    if (!alliance) return { ok: false as const, code: "not_found" };
    if (alliance.founderNationId !== actorNationId) {
      return { ok: false as const, code: "not_founder" };
    }
    if (targetNationId === actorNationId) {
      return { ok: false as const, code: "cannot_kick_self" };
    }
    const deleted = await tx
      .delete(allianceMembersTable)
      .where(
        and(
          eq(allianceMembersTable.allianceId, allianceId),
          eq(allianceMembersTable.nationId, targetNationId),
        ),
      )
      .returning({ id: allianceMembersTable.id });
    if (deleted.length === 0) {
      return { ok: false as const, code: "not_member" };
    }
    return { ok: true as const, allianceName: alliance.name };
  });
}

// ── 邀請／申請 ──────────────────────────────────────────────────

export type InviteResult =
  | { ok: true; allianceName: string }
  | {
      ok: false;
      code: "not_found" | "not_founder" | "already_member" | "duplicate";
    };

/** 聯盟（創始國）邀請某國家加入。 */
export async function inviteToAlliance(
  allianceId: string,
  actorNationId: string,
  targetNationId: string,
): Promise<InviteResult> {
  try {
    return await db.transaction(async (tx) => {
      const [alliance] = await tx
        .select()
        .from(alliancesTable)
        .where(eq(alliancesTable.id, allianceId))
        .limit(1);
      if (!alliance) return { ok: false as const, code: "not_found" };
      if (alliance.founderNationId !== actorNationId) {
        return { ok: false as const, code: "not_founder" };
      }
      // 多聯盟制：對方已屬其他聯盟仍可邀請；只擋「已是本聯盟成員」。
      if (await isAllianceMember(allianceId, targetNationId, tx)) {
        return { ok: false as const, code: "already_member" };
      }
      await tx.insert(allianceInvitesTable).values({
        allianceId,
        nationId: targetNationId,
        direction: "invite",
        status: "pending",
      });
      return { ok: true as const, allianceName: alliance.name };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") return { ok: false, code: "duplicate" };
    throw err;
  }
}

/** 某國家申請加入某聯盟。 */
export async function applyToAlliance(
  allianceId: string,
  nationId: string,
): Promise<InviteResult> {
  try {
    return await db.transaction(async (tx) => {
      const [alliance] = await tx
        .select()
        .from(alliancesTable)
        .where(eq(alliancesTable.id, allianceId))
        .limit(1);
      if (!alliance) return { ok: false as const, code: "not_found" };
      // 多聯盟制：已屬其他聯盟仍可申請；只擋「已是本聯盟成員」。
      if (await isAllianceMember(allianceId, nationId, tx)) {
        return { ok: false as const, code: "already_member" };
      }
      await tx.insert(allianceInvitesTable).values({
        allianceId,
        nationId,
        direction: "application",
        status: "pending",
      });
      return { ok: true as const, allianceName: alliance.name };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") return { ok: false, code: "duplicate" };
    throw err;
  }
}

export type RespondInviteResult =
  | { ok: true; joined: boolean; allianceId: string; allianceName: string }
  | {
      ok: false;
      code: "not_found" | "not_founder" | "already_member";
    };

/**
 * 受邀國回覆聯盟邀請（direction='invite'）。accept=true 則加入。
 */
export async function respondToInvite(
  inviteId: number,
  nationId: string,
  accept: boolean,
): Promise<RespondInviteResult> {
  try {
    return await db.transaction(async (tx) => {
      await lockNation(tx, nationId);
      const [invite] = await tx
        .select()
        .from(allianceInvitesTable)
        .where(
          and(
            eq(allianceInvitesTable.id, inviteId),
            eq(allianceInvitesTable.nationId, nationId),
            eq(allianceInvitesTable.direction, "invite"),
            eq(allianceInvitesTable.status, "pending"),
          ),
        )
        .limit(1);
      if (!invite) return { ok: false as const, code: "not_found" };
      const [alliance] = await tx
        .select({ name: alliancesTable.name })
        .from(alliancesTable)
        .where(eq(alliancesTable.id, invite.allianceId))
        .limit(1);
      if (!alliance) return { ok: false as const, code: "not_found" };

      if (!accept) {
        await tx
          .update(allianceInvitesTable)
          .set({ status: "rejected" })
          .where(eq(allianceInvitesTable.id, inviteId));
        return {
          ok: true as const,
          joined: false,
          allianceId: invite.allianceId,
          allianceName: alliance.name,
        };
      }

      if (await isAllianceMember(invite.allianceId, nationId, tx)) {
        return { ok: false as const, code: "already_member" };
      }
      await tx
        .insert(allianceMembersTable)
        .values({ allianceId: invite.allianceId, nationId });
      await tx
        .update(allianceInvitesTable)
        .set({ status: "accepted" })
        .where(eq(allianceInvitesTable.id, inviteId));
      // 加入後撤除「同一聯盟」對該國的其他 pending 邀請／申請（其他聯盟不受影響）。
      await tx
        .update(allianceInvitesTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(allianceInvitesTable.allianceId, invite.allianceId),
            eq(allianceInvitesTable.nationId, nationId),
            eq(allianceInvitesTable.status, "pending"),
          ),
        );
      return {
        ok: true as const,
        joined: true,
        allianceId: invite.allianceId,
        allianceName: alliance.name,
      };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      return { ok: false, code: "already_member" };
    }
    throw err;
  }
}

export type RespondApplicationResult =
  | {
      ok: true;
      approved: boolean;
      applicantNationId: string;
      allianceName: string;
    }
  | {
      ok: false;
      code: "not_found" | "not_founder" | "already_member";
    };

/**
 * 創始國回覆入盟申請（direction='application'）。accept=true 則納入申請國。
 */
export async function respondToApplication(
  inviteId: number,
  actorNationId: string,
  accept: boolean,
): Promise<RespondApplicationResult> {
  try {
    return await db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(allianceInvitesTable)
        .where(
          and(
            eq(allianceInvitesTable.id, inviteId),
            eq(allianceInvitesTable.direction, "application"),
            eq(allianceInvitesTable.status, "pending"),
          ),
        )
        .limit(1);
      if (!invite) return { ok: false as const, code: "not_found" };
      const [alliance] = await tx
        .select()
        .from(alliancesTable)
        .where(eq(alliancesTable.id, invite.allianceId))
        .limit(1);
      if (!alliance) return { ok: false as const, code: "not_found" };
      if (alliance.founderNationId !== actorNationId) {
        return { ok: false as const, code: "not_founder" };
      }
      const applicantNationId = invite.nationId;

      if (!accept) {
        await tx
          .update(allianceInvitesTable)
          .set({ status: "rejected" })
          .where(eq(allianceInvitesTable.id, inviteId));
        return {
          ok: true as const,
          approved: false,
          applicantNationId,
          allianceName: alliance.name,
        };
      }

      await lockNation(tx, applicantNationId);
      if (await isAllianceMember(invite.allianceId, applicantNationId, tx)) {
        return { ok: false as const, code: "already_member" };
      }
      await tx
        .insert(allianceMembersTable)
        .values({ allianceId: invite.allianceId, nationId: applicantNationId });
      await tx
        .update(allianceInvitesTable)
        .set({ status: "accepted" })
        .where(eq(allianceInvitesTable.id, inviteId));
      await tx
        .update(allianceInvitesTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(allianceInvitesTable.allianceId, invite.allianceId),
            eq(allianceInvitesTable.nationId, applicantNationId),
            eq(allianceInvitesTable.status, "pending"),
          ),
        );
      return {
        ok: true as const,
        approved: true,
        applicantNationId,
        allianceName: alliance.name,
      };
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      return { ok: false, code: "already_member" };
    }
    throw err;
  }
}

// ── 讀取（世界列表 / 我的聯盟） ─────────────────────────────────

export interface AllianceMemberView {
  nationId: string;
  name: string | null;
  isNpc: boolean;
  isFounder: boolean;
}

export interface AllianceView {
  id: string;
  name: string;
  founderNationId: string | null;
  memberCount: number;
  members: AllianceMemberView[];
}

/** 世界所有聯盟（含成員；不含 discord_user_id）。供公開列表使用。 */
export async function listAlliancesWithMembers(): Promise<AllianceView[]> {
  const alliances = await db
    .select()
    .from(alliancesTable)
    .orderBy(asc(alliancesTable.createdAt), asc(alliancesTable.id));
  if (alliances.length === 0) return [];

  const memberRows = await db
    .select({
      allianceId: allianceMembersTable.allianceId,
      nationId: allianceMembersTable.nationId,
      joinedAt: allianceMembersTable.joinedAt,
      memberSerial: allianceMembersTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
    })
    .from(allianceMembersTable)
    .innerJoin(
      playerNationsTable,
      eq(allianceMembersTable.nationId, playerNationsTable.id),
    )
    .orderBy(asc(allianceMembersTable.joinedAt), asc(allianceMembersTable.id));

  const byAlliance = new Map<string, AllianceMemberView[]>();
  for (const a of alliances) byAlliance.set(a.id, []);
  for (const m of memberRows) {
    const list = byAlliance.get(m.allianceId);
    if (!list) continue;
    const alliance = alliances.find((a) => a.id === m.allianceId);
    list.push({
      nationId: m.nationId,
      name: m.name,
      isNpc: m.isNpc,
      isFounder: alliance?.founderNationId === m.nationId,
    });
  }

  return alliances.map((a) => ({
    id: a.id,
    name: a.name,
    founderNationId: a.founderNationId,
    memberCount: byAlliance.get(a.id)?.length ?? 0,
    members: byAlliance.get(a.id) ?? [],
  }));
}

export interface AllianceInviteView {
  id: number;
  allianceId: string;
  allianceName: string;
  nationId: string;
  nationName: string | null;
  direction: "invite" | "application";
  createdAt: string;
}

export interface MyAllianceMembership {
  alliance: AllianceView;
  isFounder: boolean;
}

export interface MyAllianceContext {
  /** 我所屬的所有聯盟（依加入時間排序；多聯盟制）。 */
  memberships: MyAllianceMembership[];
  /** 我收到、尚待回覆的入盟邀請（direction='invite'）。 */
  invitesForMe: AllianceInviteView[];
  /** 我送出、尚待對方核准的入盟申請（direction='application'）。 */
  myApplications: AllianceInviteView[];
  /** 他國對「我創始的聯盟」的入盟申請（direction='application'，跨所有我創始的聯盟）。 */
  applicationsToMyAlliance: AllianceInviteView[];
}

/** 我的聯盟總覽：所屬聯盟（含成員）＋與我相關的 pending 邀請／申請。 */
export async function getMyAllianceContext(
  nationId: string,
): Promise<MyAllianceContext> {
  const allianceIds = await getNationAllianceIds(nationId);
  const memberships: MyAllianceMembership[] = [];
  if (allianceIds.length > 0) {
    const all = await listAlliancesWithMembers();
    for (const id of allianceIds) {
      const alliance = all.find((a) => a.id === id);
      if (!alliance) continue;
      memberships.push({
        alliance,
        isFounder: alliance.founderNationId === nationId,
      });
    }
  }
  const foundedAllianceIds = memberships
    .filter((m) => m.isFounder)
    .map((m) => m.alliance.id);

  // 與我相關的 pending 邀請／申請（我為受方，或我送出的申請）。
  const mineRows = await db
    .select({
      id: allianceInvitesTable.id,
      allianceId: allianceInvitesTable.allianceId,
      allianceName: alliancesTable.name,
      nationId: allianceInvitesTable.nationId,
      direction: allianceInvitesTable.direction,
      createdAt: allianceInvitesTable.createdAt,
    })
    .from(allianceInvitesTable)
    .innerJoin(
      alliancesTable,
      eq(allianceInvitesTable.allianceId, alliancesTable.id),
    )
    .where(
      and(
        eq(allianceInvitesTable.nationId, nationId),
        eq(allianceInvitesTable.status, "pending"),
      ),
    )
    .orderBy(asc(allianceInvitesTable.createdAt));

  const invitesForMe: AllianceInviteView[] = [];
  const myApplications: AllianceInviteView[] = [];
  for (const r of mineRows) {
    const view: AllianceInviteView = {
      id: r.id,
      allianceId: r.allianceId,
      allianceName: r.allianceName,
      nationId: r.nationId,
      nationName: null,
      direction: r.direction as "invite" | "application",
      createdAt: r.createdAt.toISOString(),
    };
    if (r.direction === "invite") invitesForMe.push(view);
    else myApplications.push(view);
  }

  // 他國對「我創始的聯盟」的申請（跨所有我創始的聯盟）。
  const applicationsToMyAlliance: AllianceInviteView[] = [];
  if (foundedAllianceIds.length > 0) {
    const appRows = await db
      .select({
        id: allianceInvitesTable.id,
        allianceId: allianceInvitesTable.allianceId,
        allianceName: alliancesTable.name,
        nationId: allianceInvitesTable.nationId,
        nationName: playerNationsTable.name,
        createdAt: allianceInvitesTable.createdAt,
      })
      .from(allianceInvitesTable)
      .innerJoin(
        alliancesTable,
        eq(allianceInvitesTable.allianceId, alliancesTable.id),
      )
      .innerJoin(
        playerNationsTable,
        eq(allianceInvitesTable.nationId, playerNationsTable.id),
      )
      .where(
        and(
          inArray(allianceInvitesTable.allianceId, foundedAllianceIds),
          eq(allianceInvitesTable.direction, "application"),
          eq(allianceInvitesTable.status, "pending"),
        ),
      )
      .orderBy(asc(allianceInvitesTable.createdAt));
    for (const r of appRows) {
      applicationsToMyAlliance.push({
        id: r.id,
        allianceId: r.allianceId,
        allianceName: r.allianceName,
        nationId: r.nationId,
        nationName: r.nationName,
        direction: "application",
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  return {
    memberships,
    invitesForMe,
    myApplications,
    applicationsToMyAlliance,
  };
}
