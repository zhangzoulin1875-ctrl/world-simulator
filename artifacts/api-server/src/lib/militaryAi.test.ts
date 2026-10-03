/**
 * Task #643 — 魔法／奇幻兵種退件端到端驗證。
 *
 * 以屬性覆寫為樁（anthropic.messages.create）鎖住兩條核心路徑：
 *
 *  1. 退件路徑：AI 回覆 {"rejected":true, "reason":"..."} →
 *     designCustomUnit 丟出 UnitDesignRejectedError，且 recordAiAbuse
 *     確實寫入 ai_abuse_records（domain=unit_design）。
 *
 *  2. 合法路徑：AI 回覆合法兵種 JSON（未退件）→ 繞過退件邏輯，
 *     兵種模板正確入庫至 military_unit_templates。
 *
 * 使用真實開發 DB（getGameBalanceSettings / computeUnitCategoryAverages /
 * DB 寫入），不另起 HTTP server。
 */
import { strict as assert } from "node:assert";
import test, { after, afterEach, before } from "node:test";
import { eq, like } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  aiAbuseRecordsTable,
  db,
  militaryUnitTemplatesTable,
  playerNationsTable,
} from "@workspace/db";
import { designCustomUnit, UnitDesignRejectedError } from "./militaryAi";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run militaryAi tests");
}

// ── Stub 工具 ───────────────────────────────────────────────────

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

function stubAiText(text: string): () => void {
  anthropic.messages.create = (async () => ({
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  })) as unknown as MessagesCreate;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

// ── 測試資料前綴（方便清理） ────────────────────────────────────

const PREFIX = `__militaryai-test-${process.pid}__`;
const REJECT_USER = `${PREFIX}reject-user`;
const VALID_USER = `${PREFIX}valid-user`;

let restoreAi: (() => void) | null = null;

// 為合法路徑測試預先建立 player_nations 列（military_unit_templates
// 的 owner_discord_user_id 有 FK 到 player_nations.discord_user_id）。
before(async () => {
  // 先清掉可能的殘留資料
  await db
    .delete(militaryUnitTemplatesTable)
    .where(like(militaryUnitTemplatesTable.ownerDiscordUserId, `${PREFIX}%`));
  await db
    .delete(aiAbuseRecordsTable)
    .where(like(aiAbuseRecordsTable.discordUserId, `${PREFIX}%`));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `${PREFIX}%`));

  // 僅合法路徑測試需要 player_nations 列（退件路徑不入庫）
  await db.insert(playerNationsTable).values({
    discordUserId: VALID_USER,
    name: `${PREFIX}valid-nation`,
    leaderName: "測試領袖",
    government: "君主制",
  });
});

afterEach(async () => {
  if (restoreAi) {
    restoreAi();
    restoreAi = null;
  }
});

after(async () => {
  // 先刪子表，再刪 player_nations
  await db
    .delete(militaryUnitTemplatesTable)
    .where(like(militaryUnitTemplatesTable.ownerDiscordUserId, `${PREFIX}%`));
  await db
    .delete(aiAbuseRecordsTable)
    .where(like(aiAbuseRecordsTable.discordUserId, `${PREFIX}%`));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `${PREFIX}%`));
});

// ── 測試 1：退件路徑 ────────────────────────────────────────────

test(
  "designCustomUnit: AI 退件（魔法元素）→ 丟出 UnitDesignRejectedError 並寫入 recordAiAbuse",
  async (t) => {
    const reason = "含有魔法元素：龍騎兵違反架空世界真實歷史設定，退件";

    restoreAi = stubAiText(
      JSON.stringify({ rejected: true, reason }),
    );

    t.after(async () => {
      await db
        .delete(aiAbuseRecordsTable)
        .where(eq(aiAbuseRecordsTable.discordUserId, REJECT_USER));
    });

    await assert.rejects(
      () =>
        designCustomUnit({
          ownerDiscordUserId: REJECT_USER,
          category: "armor",
          requirement: "龍騎兵：騎乘飛龍、噴火攻擊的菁英騎兵",
          eraSlug: "early_medieval",
          nation: { id: crypto.randomUUID(), name: "測試退件王國" },
        }),
      (err: unknown) => {
        assert.ok(
          err instanceof UnitDesignRejectedError,
          `應丟出 UnitDesignRejectedError，實際為：${String(err)}`,
        );
        assert.ok(
          err.message.includes(reason),
          `錯誤訊息應包含退件原因，實際：${err.message}`,
        );
        return true;
      },
    );

    // 確認 recordAiAbuse 確實寫入 ai_abuse_records
    const [record] = await db
      .select({
        domain: aiAbuseRecordsTable.domain,
        verdict: aiAbuseRecordsTable.verdict,
        discordUserId: aiAbuseRecordsTable.discordUserId,
        inputText: aiAbuseRecordsTable.inputText,
        reason: aiAbuseRecordsTable.reason,
      })
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.discordUserId, REJECT_USER))
      .limit(1);

    assert.ok(record, "recordAiAbuse 應已寫入 ai_abuse_records");
    assert.equal(record.domain, "unit_design", "domain 應為 unit_design");
    assert.equal(record.verdict, "rejected", "verdict 應為 rejected");
    assert.ok(
      record.inputText?.includes("龍騎兵"),
      "inputText 應帶入玩家原始需求",
    );
    assert.equal(record.reason, reason, "reason 應與 AI 退件原因一致");
  },
);

// ── 測試 2：合法路徑 ────────────────────────────────────────────

/**
 * 合法的兵種 JSON（通過 unitDesignSchema 驗證），
 * 對應 ranged 類別 / classical 時代的典型長弓手設計。
 */
const VALID_UNIT_JSON = JSON.stringify({
  name: "長弓手",
  description: "精通長弓的精銳弓手，善於遠程攻擊，弱於近身肉搏。",
  hp: 80,
  attack: 120,
  defense: 5,
  speed: 1,
  accuracy: 85,
  range: "ranged",
  antiCavalryPct: 10,
  antiRangedPct: 0,
  antiArtilleryPct: 0,
  siegePct: 5,
  prodCostPer100: 2,
  popCostPerUnit: 1,
  moneyCostPerUnit: 50,
  upkeepPerUnit: 0.1,
  prodUpkeepPerUnit: 0.1,
  woodCostPerUnit: 1,
  oreCostPerUnit: 0,
});

test(
  "designCustomUnit: AI 回覆合法 JSON（未退件）→ 繞過退件邏輯並正確入庫",
  async (t) => {
    restoreAi = stubAiText(VALID_UNIT_JSON);

    t.after(async () => {
      await db
        .delete(militaryUnitTemplatesTable)
        .where(
          eq(militaryUnitTemplatesTable.ownerDiscordUserId, VALID_USER),
        );
    });

    const result = await designCustomUnit({
      ownerDiscordUserId: VALID_USER,
      category: "ranged",
      requirement: "普通弓手",
      eraSlug: "classical",
    });

    // 確認回傳值帶有兵種主鍵（已入庫）
    assert.ok(result.id, "designCustomUnit 應回傳含 id 的已入庫模板");
    assert.equal(result.name, "長弓手", "兵種名稱應與 AI 回覆一致");
    assert.equal(result.range, "ranged", "range 應為 ranged");
    assert.equal(
      result.ownerDiscordUserId,
      VALID_USER,
      "owner 應為呼叫方 discordUserId",
    );

    // 確認模板確實寫入 DB
    const [row] = await db
      .select({ id: militaryUnitTemplatesTable.id })
      .from(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.id, result.id))
      .limit(1);

    assert.ok(row, "military_unit_templates 應有對應列");

    // 確認沒有誤寫 ai_abuse_records（合法請求不應觸發退件紀錄）
    const [abuse] = await db
      .select({ id: aiAbuseRecordsTable.id })
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.discordUserId, VALID_USER))
      .limit(1);

    assert.equal(abuse, undefined, "合法請求不應寫入 ai_abuse_records");
  },
);
