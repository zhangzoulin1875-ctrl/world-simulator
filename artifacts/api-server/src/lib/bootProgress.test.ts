import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootStep, bootPhase, markBackgroundStarted, getBootSnapshot, __resetBootProgressForTest } from "./bootProgress";

beforeEach(() => __resetBootProgressForTest());

test("步驟進行中：快照指出『目前卡在哪一步、卡多久』", async () => {
  bootPhase("migrating");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const p = bootStep("runSlowMigration", () => gate);
  await new Promise((r) => setTimeout(r, 30));
  const snap = getBootSnapshot();
  assert.equal(snap.phase, "migrating");
  assert.equal(snap.currentStep, "runSlowMigration");
  assert.ok(snap.currentStepForSec !== null && snap.currentStepForSec >= 0);
  assert.equal(snap.completedSteps, 0);
  release(); await p;
  const after = getBootSnapshot();
  assert.equal(after.currentStep, null);
  assert.equal(after.completedSteps, 1);
  assert.equal(after.slowestStep?.name, "runSlowMigration");
});

test("步驟拋錯：照樣往上拋（維持原本行為），並記進 failedSteps", async () => {
  await assert.rejects(bootStep("runBroken", async () => { throw new Error("relation x does not exist"); }), /does not exist/);
  const snap = getBootSnapshot();
  assert.equal(snap.failedSteps.length, 1);
  assert.equal(snap.failedSteps[0]!.name, "runBroken");
  assert.match(snap.failedSteps[0]!.error, /does not exist/);
  assert.equal(snap.currentStep, null, "失敗後不會一直顯示卡在這一步");
});

test("回傳值原樣傳回；同步函式也能包", async () => {
  assert.equal(await bootStep("a", async () => 42), 42);
  assert.equal(await bootStep("b", () => "x"), "x");
  assert.equal(getBootSnapshot().completedSteps, 2);
});

test("背景工作啟動後 phase=running，並記錄啟動時間", () => {
  markBackgroundStarted();
  const snap = getBootSnapshot();
  assert.equal(snap.phase, "running");
  assert.ok(snap.backgroundStartedAt);
});

test("failedSteps 只保留最近 5 筆，避免無限增長", async () => {
  for (let i = 0; i < 8; i++) await bootStep(`s${i}`, async () => { throw new Error("e"); }).catch(() => undefined);
  assert.equal(getBootSnapshot().failedSteps.length, 5);
  assert.equal(getBootSnapshot().failedSteps.at(-1)!.name, "s7");
});
