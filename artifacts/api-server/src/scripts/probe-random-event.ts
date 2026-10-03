/**
 * Task #407 — 用真實 AI 驗證 generateRandomEvent 的 modifiers 跨面向分佈。
 * 手動執行：pnpm --filter @workspace/api-server exec tsx src/scripts/probe-random-event.ts
 */
import { generateRandomEvent } from "../lib/politicsAi";
import type { PoliticsDirection } from "../lib/politics";

const combos: {
  government: string;
  direction: PoliticsDirection;
  good: boolean;
}[] = [
  { government: "神權制", direction: "religion", good: true },
  { government: "神權制", direction: "religion", good: false },
  { government: "軍事獨裁", direction: "law", good: true },
  { government: "軍事獨裁", direction: "law", good: false },
  { government: "財閥共和", direction: "culture", good: true },
  { government: "財閥共和", direction: "culture", good: false },
  { government: "民主共和", direction: "rights", good: true },
  { government: "民主共和", direction: "rights", good: false },
  { government: "君主立憲", direction: "culture", good: true },
  { government: "部落聯盟", direction: "religion", good: false },
  { government: "社會主義共和", direction: "rights", good: true },
  { government: "貴族制", direction: "law", good: false },
];

async function main() {
  const results = await Promise.all(
    combos.map(async (c) => {
      try {
        const ev = await generateRandomEvent({
          government: c.government,
          direction: c.direction,
          eraSlug: "industrial",
          good: c.good,
        });
        return { combo: c, ev, error: null as string | null };
      } catch (err) {
        return { combo: c, ev: null, error: String(err) };
      }
    }),
  );

  const targetCounts: Record<string, number> = {};
  let legacySatisfaction = 0;
  let multiTarget = 0;
  let oversized = 0;
  let toneMismatch = 0;
  let ok = 0;

  for (const r of results) {
    const label = `${r.combo.government}/${r.combo.direction}/${r.combo.good ? "好" : "壞"}`;
    if (!r.ev) {
      console.log(`✗ ${label} — ERROR: ${r.error}`);
      continue;
    }
    ok++;
    const mods = r.ev.modifiers;
    const targets = new Set(mods.map((m) => m.target));
    if (targets.size > 1) multiTarget++;
    for (const m of mods) {
      targetCounts[m.target] = (targetCounts[m.target] ?? 0) + 1;
      if (m.target === "satisfaction") legacySatisfaction++;
      if (Math.abs(m.value) > 20) oversized++;
    }
    const signs = mods.map((m) => Math.sign(m.value));
    const dominant = r.combo.good
      ? signs.filter((s) => s > 0).length
      : signs.filter((s) => s < 0).length;
    if (dominant < signs.length / 2) toneMismatch++;
    console.log(
      `✓ ${label} — ${r.ev.title} | dur=${r.ev.durationTurns} | ` +
        mods.map((m) => `${m.target}:${m.value}`).join(", "),
    );
  }

  console.log("\n=== 統計 ===");
  console.log(`成功 ${ok}/${combos.length}`);
  console.log(`目標分佈:`, targetCounts);
  console.log(`舊式 satisfaction 出現次數: ${legacySatisfaction}`);
  console.log(`跨多目標事件數: ${multiTarget}/${ok}`);
  console.log(`超出 ±20 的 modifier 數: ${oversized}`);
  console.log(`好壞方向不符事件數: ${toneMismatch}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
