import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * 跨庫搬家整合測試。需要兩個「可丟棄」的空結構資料庫(結構相同,例如各跑過一次啟動遷移):
 *   MIGRATE_TEST_SRC_URL  來源(測試會寫入假資料)
 *   MIGRATE_TEST_DST_URL  目標(測試會清空)
 * 未設定則整檔跳過。只允許 localhost / 127.0.0.1,避免誤傷正式庫。
 *
 * 警告:測試會 TRUNCATE 兩個庫的「全部表」(含地圖、科技樹種子)。來源/目標必須是專用庫,
 * 不可與其他整合測試共用的 DATABASE_URL 相同;跑完若要給其他測試用,需重跑一次啟動遷移還原種子。
 */
const SRC = process.env["MIGRATE_TEST_SRC_URL"];
const DST = process.env["MIGRATE_TEST_DST_URL"];
const local = (u?: string) => !!u && /@(localhost|127\.0\.0\.1)(:|\/)/.test(u);
const skip = !SRC || !DST || SRC === DST || SRC === process.env["DATABASE_URL"] || DST === process.env["DATABASE_URL"] || !local(SRC) || !local(DST) ? "需設定 MIGRATE_TEST_SRC_URL / MIGRATE_TEST_DST_URL(本機專用庫,且不可等於 DATABASE_URL)" : false;

const { pg } = await import("@workspace/db");
const { copyAllData, sortTablesByForeignKeys } = await import("./copyData");

test("外鍵排序:被參照表在前、有環不漏表", () => {
  const o = sortTablesByForeignKeys(["c", "b", "a", "d"], [{ child: "c", parent: "b" }, { child: "b", parent: "a" }, { child: "d", parent: "d" }]);
  assert.ok(o.indexOf("a") < o.indexOf("b") && o.indexOf("b") < o.indexOf("c"));
  const cyc = sortTablesByForeignKeys(["x", "y", "z"], [{ child: "x", parent: "y" }, { child: "y", parent: "x" }]);
  assert.equal(new Set(cyc).size, 3);
});

test("跨庫搬家:內容、型別、序列、安全護欄", { skip, timeout: 120_000 }, async () => {
  const a = new pg.Client({ connectionString: SRC }); await a.connect();
  const b = new pg.Client({ connectionString: DST }); await b.connect();
  try {
    // 重置兩邊,避免被先前測試殘留影響
    const tabs = (await a.query("select table_name t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")).rows.map((r: { t: string }) => r.t);
    await a.query(`truncate ${tabs.map((t: string) => `public."${t}"`).join(",")} restart identity cascade`);

    const bin = Buffer.from([0, 1, 2, 255, 254, 128, 0, 0, 7]);
    await a.query("insert into game_images (content_type, byte_size, bytes) values ('image/png', $1, $2), ('image/x', 0, $3)", [bin.length, bin, Buffer.alloc(0)]);
    await a.query("insert into military_weapons (name, description, compatible_categories, skill_name, skill_description, skill_effect) values ('長弓 \"x\" ''y''', $1, $2, 's','d','e'), ('空陣列','d',$3,'s','d','e')", ["含換行\n與中文😀", ["infantry", "ranged"], []]);
    await a.query("insert into ai_usage_logs (feature, tier, model) select 'f'||g, 'bulk', 'm' from generate_series(1, 1234) g");
    await a.query("alter sequence ai_usage_logs_id_seq restart with 9000000000");
    await a.query("insert into ai_usage_logs (feature, tier, model) values ('big','bulk','m')");
    // JSON 邊界:陣列、巢狀、字串、數字、布林、JSON null、SQL NULL、空物件
    const vals = [`[1,2,{"x":[true,null]}]`, `"字串"`, `42`, `true`, `null`, `{}`, `[]`, `{"中":"文","n":{"a":[1,2,3]}}`];
    for (const v of vals) await a.query("insert into super_events (target_stats) select $1::jsonb from information_schema.tables limit 0").catch(() => {});
    const req = (await a.query("select column_name c, data_type d from information_schema.columns where table_schema='public' and table_name='super_events' and is_nullable='NO' and column_default is null and column_name<>'target_stats'")).rows as Array<{ c: string; d: string }>;
    const fill = (r: { d: string }, i: number) => (r.d === "integer" ? 1 : r.d === "boolean" ? true : `x${i}`);
    const cols = ["target_stats", ...req.map((r) => r.c)];
    for (const [i, v] of vals.entries()) {
      await a.query(`insert into super_events (${cols.map((c) => `"${c}"`).join(",")}) values ($1::jsonb${req.map((_, k) => `,$${k + 2}`).join("")})`, [v, ...req.map((r) => fill(r, i))]);
    }
    if (req.length) await a.query(`insert into super_events (${req.map((r) => `"${r.c}"`).join(",")}) values (${req.map((_, k) => `$${k + 1}`).join(",")})`, req.map((r) => fill(r, 99)));

    // 護欄:目標非空且未 truncate → 拒絕且不動目標
    await b.query(`truncate ${tabs.map((t: string) => `public."${t}"`).join(",")} restart identity cascade`);
    await b.query("insert into game_images (content_type, byte_size, bytes) values ('pre', 1, $1)", [Buffer.from([1])]);
    await assert.rejects(copyAllData(SRC!, DST!, {}), /已有資料/);
    assert.equal(Number((await b.query("select count(*)::int n from game_images")).rows[0].n), 1);

    // 正式複製
    const rep = await copyAllData(SRC!, DST!, { truncateTarget: true });
    assert.deepEqual(rep.tables.filter((t) => !t.ok), []);
    assert.equal(rep.ok, true);

    // 逐表內容雜湊
    const diff: string[] = [];
    for (const t of tabs) {
      const h = async (c: InstanceType<typeof pg.Client>) => createHash("sha256").update(JSON.stringify((await c.query(`select t::text x from public."${t}" t order by 1`)).rows)).digest("hex");
      if ((await h(a)) !== (await h(b))) diff.push(t);
    }
    assert.deepEqual(diff, []);

    // SQL NULL 與 JSON null 必須區分
    const q = "select coalesce(target_stats::text,'<SQLNULL>') v, jsonb_typeof(target_stats) ty from super_events order by 1,2";
    const sa = (await a.query(q)).rows, sb = (await b.query(q)).rows;
    assert.deepEqual(sb, sa);
    if (req.length) assert.ok(sb.some((r: { v: string; ty: string }) => r.v === "null" && r.ty === "null") && sb.some((r: { v: string }) => r.v === "<SQLNULL>"));

    // 二進位、陣列、特殊字元
    const img = (await b.query("select bytes from game_images where byte_size = $1", [bin.length])).rows[0];
    assert.equal(Buffer.compare(img.bytes, bin), 0);
    const w = (await b.query("select name, description, compatible_categories c from military_weapons order by id")).rows;
    assert.equal(w[0].name, '長弓 "x" \'y\'');
    assert.equal(w[0].description, "含換行\n與中文😀");
    assert.deepEqual(w[0].c, ["infantry", "ranged"]);
    assert.deepEqual(w[1].c, []);

    // 序列續號(含超過 int32 的 bigint)
    await b.query("insert into ai_usage_logs (feature, tier, model) values ('after','bulk','m')");
    const mx = (await b.query("select max(id)::text m, count(*)::int n from ai_usage_logs")).rows[0];
    assert.equal(mx.n, 1236);
    assert.equal(BigInt(mx.m), 9000000001n);
    await b.query("insert into game_images (content_type, byte_size, bytes) values ('after', 1, $1)", [Buffer.from([1])]);
  } finally {
    await a.end(); await b.end();
  }
});
