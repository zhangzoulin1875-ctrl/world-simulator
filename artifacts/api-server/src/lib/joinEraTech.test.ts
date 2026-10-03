import assert from "node:assert/strict";
import { test } from "node:test";
import { keyTechSlugsBeforeEra } from "./joinEraTech";

const CATALOG = [
  { keySlug: "a", eraSlug: "classical" },
  { keySlug: "b", eraSlug: "roman" },
  { keySlug: "c", eraSlug: "roman" },
  { keySlug: "d", eraSlug: "renaissance" },
  { keySlug: "e", eraSlug: "modern" },
];

test("classical world era grants nothing (no earlier era)", () => {
  assert.deepEqual(keyTechSlugsBeforeEra(CATALOG, "classical"), []);
});

test("mid era grants only strictly-earlier key techs, in order", () => {
  assert.deepEqual(keyTechSlugsBeforeEra(CATALOG, "renaissance"), [
    "a",
    "b",
    "c",
  ]);
});

test("current-era key techs are NOT granted (strictly-before only)", () => {
  // roman world era → only classical ("a"); roman techs themselves excluded.
  assert.deepEqual(keyTechSlugsBeforeEra(CATALOG, "roman"), ["a"]);
});

test("late era grants all earlier key techs", () => {
  assert.deepEqual(keyTechSlugsBeforeEra(CATALOG, "modern"), [
    "a",
    "b",
    "c",
    "d",
  ]);
});

test("invalid world era slug grants nothing", () => {
  assert.deepEqual(keyTechSlugsBeforeEra(CATALOG, "not_an_era"), []);
});

test("entries with invalid era slug are skipped defensively", () => {
  const bad = [
    { keySlug: "x", eraSlug: "classical" },
    { keySlug: "y", eraSlug: "bogus" },
  ];
  assert.deepEqual(keyTechSlugsBeforeEra(bad, "modern"), ["x"]);
});
