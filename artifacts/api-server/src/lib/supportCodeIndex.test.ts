import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  parseTarGz, buildIndex, searchIndex, tokenize, redactSecrets, shouldIndex, formatHits,
  CHUNK_LINES, MAX_FILE_BYTES,
} from "./supportCodeIndex";

/** 組一個最小的 ustar tar.gz（含 GitHub 風格的第一層目錄）。 */
function makeTarGz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("parseTarGz：去掉第一層目錄、只收文字原始碼、排除 node_modules／.env／generated／鎖檔／過大檔", () => {
  const big = "x".repeat(MAX_FILE_BYTES + 10);
  const files = parseTarGz(makeTarGz({
    "repo-abc/artifacts/api-server/src/lib/economy.ts": "export const tax = 1;\n// 稅收計算\n",
    "repo-abc/README.md": "# 說明\n本遊戲是模擬器。",
    "repo-abc/node_modules/x/index.ts": "export const a = 1;",
    "repo-abc/.env": "SECRET=abc",
    "repo-abc/pnpm-lock.yaml": "lock",
    "repo-abc/lib/api-zod/src/generated/api.ts": "export const generated = 1;",
    "repo-abc/artifacts/api-server/src/lib/big.ts": big,
    "repo-abc/logo.png": "binary",
    "repo-abc/artifacts/api-server/src/lib/supportKnowledge.ts": "export const k = 1;",
  }));
  assert.deepEqual([...files.keys()].sort(), ["README.md", "artifacts/api-server/src/lib/economy.ts"]);
  assert.match(files.get("artifacts/api-server/src/lib/economy.ts")!, /稅收計算/);
});

test("shouldIndex 規則", () => {
  assert.equal(shouldIndex("a/b.ts", 100), true);
  assert.equal(shouldIndex("a/b.tsx", 100), true);
  assert.equal(shouldIndex("a/b.json", 100), false);
  assert.equal(shouldIndex("a/b.ts", 0), false);
  assert.equal(shouldIndex("a/mapGeometry.ts", 100), false);
});

test("redactSecrets：遮蔽寫死的金鑰字面值，但保留一般讀環境變數的程式碼", () => {
  assert.equal(redactSecrets('const apiKey = "nvapi-AbCdEf1234567890XYZ";'), "[已遮蔽疑似機密的行]");
  assert.equal(redactSecrets("password: 'hunter2hunter2'"), "[已遮蔽疑似機密的行]");
  assert.equal(redactSecrets("const token = process.env.DISCORD_TOKEN;"), "const token = process.env.DISCORD_TOKEN;");
  assert.equal(redactSecrets("const tax = pop * rate / 10000;"), "const tax = pop * rate / 10000;");
  assert.match(redactSecrets("const id = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7s';"), /\[已遮蔽\]/);
  assert.equal(redactSecrets("export function populationCapacityFromProductionTechnology() {}"), "export function populationCapacityFromProductionTechnology() {}");
});

test("tokenize：英文識別字拆 camelCase；中文取二字詞；去掉停用詞", () => {
  const t = tokenize("為什麼 populationCapacity 會讓人口減少？");
  for (const w of ["populationcapacity", "population", "capacity", "人口", "減少"]) assert.ok(t.includes(w), `缺 ${w}：${t}`);
  assert.ok(!t.includes("為什麼"));
  assert.deepEqual(tokenize("a 的 了"), []);
});

function sampleIndex() {
  const files = new Map<string, string>([
    ["src/lib/populationCapacity.ts", "export function capacity(pop: number) {\n  // 人口超過上限時每回合減少，最多 6%\n  return Math.min(pop, 100);\n}\n"],
    ["src/lib/parliament/core.ts", "export function judgeCompliance() {\n  // 議會滿意度與和平派判定\n}\n"],
    ["src/lib/recruit.ts", "export const recruit = () => 'recruit units costs production';\n"],
    ["src/long.ts", Array.from({ length: 200 }, (_, i) => `const line${i} = ${i}; // 第${i}行 filler`).join("\n")],
  ]);
  return buildIndex(files, "abc1234");
}

test("buildIndex：短檔 1 片、長檔依行數切片且有重疊，行號正確", () => {
  const idx = sampleIndex();
  const long = idx.chunks.filter((c) => c.path === "src/long.ts");
  assert.ok(long.length >= 4);
  assert.equal(long[0]!.start, 1);
  assert.equal(long[0]!.end, CHUNK_LINES);
  assert.ok(long[1]!.start < long[0]!.end, "片段間有重疊");
  assert.equal(long.at(-1)!.end, 200);
  assert.equal(idx.commit, "abc1234");
});

test("searchIndex：中文問題找到對應實作檔；路徑命中加權；無關詞回空", () => {
  const idx = sampleIndex();
  assert.equal(searchIndex(idx, "人口 上限 減少")[0]!.chunk.path, "src/lib/populationCapacity.ts");
  assert.equal(searchIndex(idx, "judgeCompliance 和平派")[0]!.chunk.path, "src/lib/parliament/core.ts");
  assert.equal(searchIndex(idx, "recruit")[0]!.chunk.path, "src/lib/recruit.ts");
  assert.deepEqual(searchIndex(idx, "zzzzqqq 完全無關"), []);
  assert.deepEqual(searchIndex(idx, ""), []);
});

test("searchIndex：同一檔最多 2 片、總數受 limit 限制", () => {
  const idx = sampleIndex();
  const hits = searchIndex(idx, "filler line", 6);
  assert.ok(hits.filter((h) => h.chunk.path === "src/long.ts").length <= 2);
  assert.ok(searchIndex(idx, "const", 1).length <= 1);
});

test("formatHits：含檔名行號、遮蔽機密、總長有上限", () => {
  const files = new Map([["a.ts", 'const apiKey = "nvapi-AbCdEf1234567890XYZ";\nexport const ok = 1;\n// 人口'], ["b.ts", "x".repeat(50) + "\n人口 " + "y".repeat(20000)]]);
  const out = formatHits(searchIndex(buildIndex(files, "c"), "人口"), 3000);
  assert.match(out, /--- a\.ts \(第 1-3 行\) ---/);
  assert.ok(!out.includes("nvapi-AbCdEf"));
  assert.ok(out.length <= 3200, `長度 ${out.length}`);
});
