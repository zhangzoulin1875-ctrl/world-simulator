import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.NEWS_SCHEDULE_TZ ??= "Asia/Taipei";

import {
  DEFAULT_TURN_TIMES,
  ERA_START_YEARS,
  MAX_GAME_YEAR,
  MAX_TURN_TIMES,
  MIN_GAME_YEAR,
  addYearsToGameDate,
  buildGameDate,
  computeTurnProgress,
  eraForYear,
  evaluateTreasuryPenalty,
  evaluateUpkeepShortfall,
  nextDueSlot,
  normalizeTurnTimes,
  parseTurnTimes,
  yearOfGameDate,
} from "./turnEngine";
import { ERAS } from "./mapRegionEras";

// Asia/Taipei 固定 UTC+8（無日光節約），本地 HH:00 = UTC (HH-8):00。
function taipei(localDate: string, hour: number, minute = 0): Date {
  return new Date(`${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
}

test("ERA_START_YEARS 與 ERAS 順序、slug 完全一致", () => {
  assert.equal(ERA_START_YEARS.length, ERAS.length);
  for (let i = 0; i < ERAS.length; i++) {
    assert.equal(ERA_START_YEARS[i]!.slug, ERAS[i]!.slug);
  }
});

test("ERA_START_YEARS 起始年嚴格遞增，且第一個為最小年份", () => {
  assert.equal(ERA_START_YEARS[0]!.startYear, MIN_GAME_YEAR);
  for (let i = 1; i < ERA_START_YEARS.length; i++) {
    assert.ok(
      ERA_START_YEARS[i]!.startYear > ERA_START_YEARS[i - 1]!.startYear,
      `${ERA_START_YEARS[i]!.slug} 起始年必須大於前一時代`,
    );
  }
});

test("eraForYear：所有 14 個時代的邊界年（起始年前一年 / 起始年當年）", () => {
  for (let i = 0; i < ERA_START_YEARS.length; i++) {
    const { slug, startYear } = ERA_START_YEARS[i]!;
    // 起始年當年屬於該時代。
    assert.equal(eraForYear(startYear), slug, `${slug} 起始年 ${startYear}`);
    // 起始年前一年屬於前一時代（第一個時代除外）。
    if (i > 0) {
      assert.equal(
        eraForYear(startYear - 1),
        ERA_START_YEARS[i - 1]!.slug,
        `${slug} 起始年前一年 ${startYear - 1}`,
      );
    }
  }
});

test("eraForYear：極端值", () => {
  assert.equal(eraForYear(MIN_GAME_YEAR), "classical");
  assert.equal(eraForYear(-500), "classical"); // 小於最小起始年 → 第一個時代
  assert.equal(eraForYear(MAX_GAME_YEAR), "future");
  assert.equal(eraForYear(2049), "modern");
  assert.equal(eraForYear(2050), "future");
});

test("yearOfGameDate / buildGameDate", () => {
  assert.equal(yearOfGameDate("0001-01-01"), 1);
  assert.equal(yearOfGameDate("1900-06-15"), 1900);
  assert.equal(buildGameDate(5, "-03-09"), "0005-03-09");
  assert.equal(buildGameDate(1988, "-02-29"), "1988-02-29"); // 閏年保留
  assert.equal(buildGameDate(1989, "-02-29"), "1989-02-28"); // 非閏年退回
  assert.equal(buildGameDate(1900, "-02-29"), "1900-02-28"); // 百年非閏
  assert.equal(buildGameDate(2000, "-02-29"), "2000-02-29"); // 四百年閏
});

test("addYearsToGameDate：推進、上限、月日保留", () => {
  assert.equal(addYearsToGameDate("0001-01-01", 1), "0002-01-01");
  assert.equal(addYearsToGameDate("0199-07-04", 1), "0200-07-04");
  assert.equal(addYearsToGameDate("1995-12-31", 100), "2095-12-31");
  assert.equal(addYearsToGameDate("9998-01-01", 50), "9999-01-01"); // 上限
  assert.equal(addYearsToGameDate("2096-02-29", 1), "2097-02-28"); // 閏→非閏
});

test("evaluateUpkeepShortfall：缺口 > 0 才通知", () => {
  // 維護費超過 付維護費前可用金錢 → 通知，缺口正確
  assert.deepEqual(
    evaluateUpkeepShortfall({
      discordUserId: "u1",
      availableBeforeUpkeep: 150,
      upkeepCharged: 200,
    }),
    { shortfall: 50, shouldNotify: true },
  );
  // 只差 1 也要通知
  assert.deepEqual(
    evaluateUpkeepShortfall({
      discordUserId: "u1",
      availableBeforeUpkeep: 0,
      upkeepCharged: 1,
    }),
    { shortfall: 1, shouldNotify: true },
  );
});

test("evaluateUpkeepShortfall：剛好打平不通知", () => {
  assert.deepEqual(
    evaluateUpkeepShortfall({
      discordUserId: "u1",
      availableBeforeUpkeep: 200,
      upkeepCharged: 200,
    }),
    { shortfall: 0, shouldNotify: false },
  );
});

test("evaluateUpkeepShortfall：有餘裕不通知", () => {
  const r = evaluateUpkeepShortfall({
    discordUserId: "u1",
    availableBeforeUpkeep: 600,
    upkeepCharged: 200,
  });
  assert.equal(r.shouldNotify, false);
  assert.ok(r.shortfall < 0);
  // 沒有維護費 → 不通知
  assert.equal(
    evaluateUpkeepShortfall({
      discordUserId: "u1",
      availableBeforeUpkeep: 0,
      upkeepCharged: 0,
    }).shouldNotify,
    false,
  );
});

test("evaluateTreasuryPenalty：赤字（缺口 > 0）→ deficit", () => {
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: "u1", newMoney: 0, shortfall: 50 }),
    "deficit",
  );
});

test("evaluateTreasuryPenalty：國庫歸零（無缺口）→ empty", () => {
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: "u1", newMoney: 0, shortfall: 0 }),
    "empty",
  );
  // 缺口為負（有餘裕）但結算後金錢仍為 0（例如收入 0、支出 0、原本就 0）
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: "u1", newMoney: 0, shortfall: -10 }),
    "empty",
  );
});

test("evaluateTreasuryPenalty：國庫有結餘 → 無懲罰", () => {
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: "u1", newMoney: 1, shortfall: 0 }),
    null,
  );
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: "u1", newMoney: 5000, shortfall: -100 }),
    null,
  );
});

test("evaluateTreasuryPenalty：NPC／無主國家永不懲罰", () => {
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: null, newMoney: 0, shortfall: 999 }),
    null,
  );
  assert.equal(
    evaluateTreasuryPenalty({ discordUserId: null, newMoney: 0, shortfall: 0 }),
    null,
  );
});

test("evaluateUpkeepShortfall：無主國家（discordUserId null）不通知", () => {
  // 即使缺口 > 0，無主國家也不通知
  assert.deepEqual(
    evaluateUpkeepShortfall({
      discordUserId: null,
      availableBeforeUpkeep: 0,
      upkeepCharged: 100,
    }),
    { shortfall: 100, shouldNotify: false },
  );
});

test("parseTurnTimes：排序去重、回傳正規化時刻", () => {
  const r = parseTurnTimes([
    { hour: 18, minute: 30 },
    { hour: 6, minute: 0 },
    { hour: 18, minute: 30 },
    { hour: 12, minute: 15 },
  ]);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.times, [
      { hour: 6, minute: 0 },
      { hour: 12, minute: 15 },
      { hour: 18, minute: 30 },
    ]);
  }
});

test("parseTurnTimes：非陣列 / 空 / 超量 / 越界皆回 zh-TW 錯誤", () => {
  assert.equal(parseTurnTimes("x").ok, false);
  assert.equal(parseTurnTimes([]).ok, false);
  const tooMany = Array.from({ length: MAX_TURN_TIMES + 1 }, (_, i) => ({
    hour: i % 24,
    minute: 0,
  }));
  assert.equal(parseTurnTimes(tooMany).ok, false);
  assert.equal(parseTurnTimes([{ hour: 24, minute: 0 }]).ok, false);
  assert.equal(parseTurnTimes([{ hour: 0, minute: 60 }]).ok, false);
  assert.equal(parseTurnTimes([{ hour: 1.5, minute: 0 }]).ok, false);
  const bad = parseTurnTimes([]);
  if (!bad.ok) assert.ok(/更新時刻|至少/.test(bad.error));
});

test("parseTurnTimes：接受 1 筆與最多 24 筆", () => {
  assert.equal(parseTurnTimes([{ hour: 0, minute: 0 }]).ok, true);
  const max = Array.from({ length: MAX_TURN_TIMES }, (_, i) => ({
    hour: i,
    minute: 0,
  }));
  const r = parseTurnTimes(max);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.times.length, MAX_TURN_TIMES);
});

test("normalizeTurnTimes：非法輸入回退為預設單一 18:00", () => {
  assert.deepEqual(normalizeTurnTimes(null), DEFAULT_TURN_TIMES.map((t) => ({ ...t })));
  assert.deepEqual(normalizeTurnTimes("bad"), [{ hour: 18, minute: 0 }]);
  assert.deepEqual(normalizeTurnTimes([]), [{ hour: 18, minute: 0 }]);
});

test("normalizeTurnTimes：過濾非法值後保留合法時刻並排序去重", () => {
  const out = normalizeTurnTimes([
    { hour: 20, minute: 0 },
    { hour: 99, minute: 0 },
    { hour: 8, minute: 0 },
    { hour: 20, minute: 0 },
  ]);
  assert.deepEqual(out, [
    { hour: 8, minute: 0 },
    { hour: 20, minute: 0 },
  ]);
});

test("nextDueSlot：未到任何時刻回 null", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 5, 0);
  assert.equal(nextDueSlot(times, now, null, "2026-07-06"), null);
});

test("nextDueSlot：認領最早的到期且尚未執行時段", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 12, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 13, 0);
  // 尚未執行過：應認領最早的 06:00。
  const due = nextDueSlot(times, now, null, "2026-07-06");
  assert.ok(due);
  assert.equal(due!.getTime(), taipei("2026-07-06", 6, 0).getTime());
});

test("nextDueSlot：last_turn_at 後只認領其後的到期時段（逐一補跑）", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 12, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 19, 0);
  const last = taipei("2026-07-06", 6, 0);
  const due = nextDueSlot(times, now, last, "2026-07-06");
  assert.ok(due);
  assert.equal(due!.getTime(), taipei("2026-07-06", 12, 0).getTime());
});

test("nextDueSlot：全部執行完回 null", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 12, minute: 0 },
  ];
  const now = taipei("2026-07-06", 23, 0);
  const last = taipei("2026-07-06", 12, 0);
  assert.equal(nextDueSlot(times, now, last, "2026-07-06"), null);
});

test("computeTurnProgress：今日未執行 → 0/N、下一時刻為第一個到期或第一個時段", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 12, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 13, 0);
  const p = computeTurnProgress(times, now, null, "2026-07-06");
  assert.equal(p.runsToday, 0);
  assert.equal(p.totalToday, 3);
  assert.deepEqual(p.nextTime, { hour: 6, minute: 0 });
});

test("computeTurnProgress：部分執行 → runsToday 計數、下一時刻正確", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 12, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 13, 0);
  const last = taipei("2026-07-06", 12, 0);
  const p = computeTurnProgress(times, now, last, "2026-07-06");
  assert.equal(p.runsToday, 2);
  assert.equal(p.totalToday, 3);
  assert.deepEqual(p.nextTime, { hour: 18, minute: 0 });
});

test("computeTurnProgress：全部執行完 → runsToday=N、下一時刻回明日第一個時段", () => {
  const times = [
    { hour: 6, minute: 0 },
    { hour: 18, minute: 0 },
  ];
  const now = taipei("2026-07-06", 20, 0);
  const last = taipei("2026-07-06", 18, 0);
  const p = computeTurnProgress(times, now, last, "2026-07-06");
  assert.equal(p.runsToday, 2);
  assert.equal(p.totalToday, 2);
  assert.deepEqual(p.nextTime, { hour: 6, minute: 0 });
});

test("computeTurnProgress：last_turn_at 為昨日 → 今日 runsToday=0", () => {
  const times = [{ hour: 18, minute: 0 }];
  const now = taipei("2026-07-06", 20, 0);
  const last = taipei("2026-07-05", 18, 0);
  const p = computeTurnProgress(times, now, last, "2026-07-06");
  assert.equal(p.runsToday, 0);
  assert.deepEqual(p.nextTime, { hour: 18, minute: 0 });
});
