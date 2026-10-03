import { strict as assert } from "node:assert";
import test from "node:test";
import { buildGeoCultureText, type GeoRegionInput } from "./nationGeoCulture";

// Real region names from mapConstants.generated (REGION_ASSIGNMENTS):
//   europe_west: 蘇格蘭高地/蘇格蘭低地/北愛爾蘭區/北威爾斯
//   china_core:  幽州/津沽/冀南/河朔
//   japan:       北海道/東北地方/江戶平原
//   persia:      德黑蘭/伊斯法罕/胡齊斯坦

test("empty controlled regions → empty context", () => {
  assert.equal(buildGeoCultureText([], []), "");
  assert.equal(buildGeoCultureText([], ["巴黎"]), "");
});

test("non-East-Asia nation lists its geography + culture and forbids 中華 default", () => {
  const regions: GeoRegionInput[] = [
    { regionName: "蘇格蘭高地", macroRegion: "歐洲" },
    { regionName: "蘇格蘭低地", macroRegion: "歐洲" },
  ];
  const text = buildGeoCultureText(regions, ["愛丁堡"]);
  assert.match(text, /【地理人文背景】/);
  assert.match(text, /西歐/); // culture label from europe_west
  assert.match(text, /歐洲/); // macro region grouping
  assert.match(text, /愛丁堡/); // city listed
  assert.match(text, /不要預設中華／中國風格/); // East-Asia caveat present
});

test("East-Asia nation omits the 中華 caveat", () => {
  const regions: GeoRegionInput[] = [
    { regionName: "幽州", macroRegion: "東亞" },
    { regionName: "冀南", macroRegion: "東亞" },
  ];
  const text = buildGeoCultureText(regions, []);
  assert.match(text, /華夏中原/);
  assert.doesNotMatch(text, /不要預設中華/);
});

test("Japan counts as East-Asia (caveat omitted)", () => {
  const text = buildGeoCultureText(
    [{ regionName: "江戶平原", macroRegion: "東亞" }],
    [],
  );
  assert.match(text, /日本/);
  assert.doesNotMatch(text, /不要預設中華/);
});

test("caps region samples per macro at 5 with 等N個地區 suffix", () => {
  const regions: GeoRegionInput[] = [
    "蘇格蘭高地",
    "蘇格蘭低地",
    "北愛爾蘭區",
    "北威爾斯",
    "德黑蘭",
    "伊斯法罕",
  ].map((regionName) => ({ regionName, macroRegion: "歐洲" }));
  const text = buildGeoCultureText(regions, []);
  assert.match(text, /等6個地區/);
  // Only 5 sample names before the 等N suffix.
  const line = text.split("\n").find((l) => l.startsWith("掌控地區"))!;
  const before = line.slice(0, line.indexOf("等6個地區"));
  assert.equal((before.match(/、/g) ?? []).length, 4); // 5 names → 4 separators
});

test("caps cities at 10", () => {
  const cities = Array.from({ length: 15 }, (_, i) => `城市${i + 1}`);
  const text = buildGeoCultureText(
    [{ regionName: "幽州", macroRegion: "東亞" }],
    cities,
  );
  const cityLine = text.split("\n").find((l) => l.startsWith("境內主要城市"))!;
  assert.match(cityLine, /城市10/);
  assert.doesNotMatch(cityLine, /城市11/);
});

test("unknown region name is skipped for culture but still grouped by macro", () => {
  const text = buildGeoCultureText(
    [{ regionName: "不存在的地區XYZ", macroRegion: "虛構區" }],
    [],
  );
  assert.match(text, /虛構區/); // macro grouping still shown
  assert.match(text, /【地理人文背景】/);
});

test("multiple cultures are listed ordered by region count", () => {
  const regions: GeoRegionInput[] = [
    { regionName: "德黑蘭", macroRegion: "中東" },
    { regionName: "伊斯法罕", macroRegion: "中東" },
    { regionName: "蘇格蘭高地", macroRegion: "歐洲" },
  ];
  const text = buildGeoCultureText(regions, []);
  const cultureLine = text.split("\n").find((l) => l.startsWith("主要文化圈"))!;
  // persia (2) should precede 西歐 (1).
  assert.ok(cultureLine.indexOf("波斯") < cultureLine.indexOf("西歐"));
});
