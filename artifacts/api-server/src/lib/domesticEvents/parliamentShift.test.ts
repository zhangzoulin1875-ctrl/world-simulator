import test from "node:test";
import assert from "node:assert/strict";
import { shiftParliament, hasMajority, SOCIALIST_MAJORITY_SEATS } from "./parliamentShift";
import { PARLIAMENT_TOTAL_SEATS, rulingParty, type SeatedParty } from "../parliament/core";

const P = (id: string, stance: SeatedParty["stance"], seats: number): SeatedParty => ({ id, name: id, stance, weight: seats, seats });
const sum = (ps: readonly SeatedParty[]) => ps.reduce((s, p) => s + p.seats, 0);

test("順應:沒有福利派黨時新增社會黨並拿下多數,席次總和仍為 100,其他黨每黨至少 1 席", () => {
  const before = [P("a", "militarist", 40), P("b", "pacifist", 35), P("c", "fiscal_hawk", 25)];
  const after = shiftParliament(before, "socialists_in");
  assert.equal(sum(after), PARLIAMENT_TOTAL_SEATS);
  const soc = after.find((p) => p.stance === "welfare")!;
  assert.ok(soc && soc.seats === SOCIALIST_MAJORITY_SEATS);
  assert.equal(hasMajority(after), true);
  assert.equal(rulingParty(after)!.id, soc.id);
  assert.ok(after.filter((p) => p.stance !== "welfare").every((p) => p.seats >= 1));
  assert.equal(before.length + 1, after.length);
});

test("順應:已有福利派黨時沿用它(不重複新增),一樣拿下多數", () => {
  const before = [P("a", "militarist", 50), P("w", "welfare", 20), P("c", "secular", 30)];
  const after = shiftParliament(before, "socialists_in");
  assert.equal(after.filter((p) => p.stance === "welfare").length, 1);
  assert.equal(after.find((p) => p.stance === "welfare")!.id, "w");
  assert.equal(sum(after), PARLIAMENT_TOTAL_SEATS);
  assert.equal(hasMajority(after), true);
});

test("君主制橡皮圖章(只有一個效忠黨):社會黨插入後拿多數,效忠黨保留 45 席,總和 100", () => {
  const after = shiftParliament([P("p0", "loyalist", 100)], "socialists_in");
  assert.equal(sum(after), PARLIAMENT_TOTAL_SEATS);
  assert.equal(after.find((p) => p.stance === "welfare")!.seats, SOCIALIST_MAJORITY_SEATS);
  assert.equal(after.find((p) => p.stance === "loyalist")!.seats, PARLIAMENT_TOTAL_SEATS - SOCIALIST_MAJORITY_SEATS);
});

test("鎮壓:福利派黨被逐出,席次還給其他黨,總和 100,無福利派黨", () => {
  const before = [P("a", "militarist", 30), P("w", "welfare", 55), P("c", "pacifist", 15)];
  const after = shiftParliament(before, "socialists_out");
  assert.equal(sum(after), PARLIAMENT_TOTAL_SEATS);
  assert.ok(after.every((p) => p.stance !== "welfare"));
  assert.equal(after.length, 2);
});

test("鎮壓:議會裡本來就沒有福利派(或只有福利派)時原樣保留,不會把議會清空", () => {
  const none = [P("a", "militarist", 60), P("b", "pacifist", 40)];
  assert.deepEqual(shiftParliament(none, "socialists_out"), none);
  const onlyW = [P("w", "welfare", 100)];
  assert.deepEqual(shiftParliament(onlyW, "socialists_out"), onlyW);
});

test("不修改輸入陣列;黨很多時(6 黨)席次仍精確為 100", () => {
  const before = [P("a", "militarist", 20), P("b", "pacifist", 20), P("c", "fiscal_hawk", 20), P("d", "religious", 15), P("e", "secular", 15), P("f", "mercantile", 10)];
  const snap = JSON.stringify(before);
  const after = shiftParliament(before, "socialists_in");
  assert.equal(JSON.stringify(before), snap);
  assert.equal(sum(after), PARLIAMENT_TOTAL_SEATS);
  assert.equal(hasMajority(after), true);
});

test("先順應再鎮壓:社會黨進來又被趕走,回到沒有福利派的合法議會", () => {
  const start = [P("a", "militarist", 60), P("b", "pacifist", 40)];
  const mid = shiftParliament(start, "socialists_in");
  const end = shiftParliament(mid, "socialists_out");
  assert.equal(sum(end), PARLIAMENT_TOTAL_SEATS);
  assert.ok(end.every((p) => p.stance !== "welfare"));
  assert.equal(end.length, 2);
});
