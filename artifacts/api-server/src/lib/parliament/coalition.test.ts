import test from "node:test";
import assert from "node:assert/strict";
import {
  MAJORITY_SEATS, compatibility, formCoalition, semiCoalition, governmentStand,
  coalitionStability, coalitionRisk, defectChance, rollDefections, MAX_DEFECT_CHANCE,
} from "./coalition";
import { tallyVote, tallyVoteWithGovernment, type PolicyTag } from "./vote";
import type { SeatedParty, ParliamentStance } from "./core";

const P = (id: string, stance: ParliamentStance, seats: number): SeatedParty => ({ id, name: `黨${id}`, stance, weight: seats, seats });

test("過半門檻是 51", () => assert.equal(MAJORITY_SEATS, 51));

test("相容度：對稱、同立場 1、天然對立 0、忠誠黨 0", () => {
  const all: ParliamentStance[] = ["militarist", "pacifist", "fiscal_hawk", "welfare", "religious", "secular", "mercantile"];
  for (const a of all) for (const b of all) assert.equal(compatibility(a, b), compatibility(b, a), `${a}/${b} 不對稱`);
  for (const a of all) assert.equal(compatibility(a, a), 1);
  assert.equal(compatibility("militarist", "pacifist"), 0);
  assert.equal(compatibility("religious", "secular"), 0);
  assert.equal(compatibility("fiscal_hawk", "welfare"), 0);
  assert.equal(compatibility("loyalist", "welfare"), 0);
  for (const a of all) for (const b of all) { const c = compatibility(a, b); assert.ok(c >= 0 && c <= 1); }
});

test("單獨過半 → 單黨政府，不拉夥伴", () => {
  const r = formCoalition([P("a", "welfare", 55), P("b", "militarist", 30), P("c", "secular", 15)]);
  assert.deepEqual(r, { memberIds: ["a"], primeId: "a", seats: 55, single: true, ok: true });
});

test("沒過半 → 依相容度拉最合的黨，湊到過半就停", () => {
  // 福利 40 + 和平(0.8) 20 = 60，過半；不需要再拉世俗
  const r = formCoalition([P("a", "welfare", 40), P("b", "pacifist", 20), P("c", "secular", 25), P("d", "militarist", 15)]);
  assert.equal(r.ok, true); assert.equal(r.single, false); assert.equal(r.primeId, "a");
  assert.deepEqual(r.memberIds, ["a", "b"]); assert.equal(r.seats, 60);
});

test("夥伴不夠大就繼續拉下一個，直到過半", () => {
  // 福利 30（最大）；和平 12(0.8)、世俗 10(0.7) 依序被拉：30+12+10 = 52 過半；擴軍 48 與福利相容 0.4 排最後，用不到
  const r = formCoalition([P("a", "welfare", 30), P("b", "pacifist", 12), P("c", "secular", 10), P("d", "militarist", 48)].map((p) => (p.id === "d" ? { ...p, seats: 48 } : p)));
  assert.equal(r.primeId, "d", "擴軍 48 才是最大黨，由它組閣");
});

test("最大黨組閣；拉不到相容夥伴時失敗，而不是硬拉敵對黨", () => {
  // 擴軍 48 最大；福利 30(0.4)、和平 12(0)、世俗 10(0)。擴軍+福利 = 78 過半 → 成功且只拉福利
  const r = formCoalition([P("a", "welfare", 30), P("b", "pacifist", 12), P("c", "secular", 10), P("d", "militarist", 48)]);
  assert.equal(r.ok, true); assert.deepEqual(r.memberIds, ["d", "a"]); assert.equal(r.seats, 78);
});

test("依相容度逐個拉到剛好過半", () => {
  // 福利 30 最大；和平 12(0.8) → 42；世俗 10(0.7) → 52 過半；擴軍 48 沒被用到
  const r = formCoalition([P("a", "welfare", 30), P("b", "pacifist", 12), P("c", "secular", 10), P("d", "militarist", 48)].filter((p) => p.id !== "d").concat([P("e", "religious", 48)]));
  // 宗教 48 最大 → 宗教+擴軍…沒有擴軍；宗教與福利 0.4、和平/世俗 0.4(表外中性) → 依席次 福利30 → 78 過半
  assert.equal(r.primeId, "e"); assert.deepEqual(r.memberIds, ["e", "a"]);
});

test("拉不到過半（剩下的都水火不容）→ 失敗", () => {
  // 擴軍 45 + 和平 55 之外沒別人；但最大黨是和平 55 單獨過半 → 這裡改成最大黨 40，其餘全是對立
  const r = formCoalition([P("a", "militarist", 40), P("b", "pacifist", 35), P("c", "pacifist", 25)]);
  assert.equal(r.ok, false); assert.deepEqual(r.memberIds, []); assert.equal(r.primeId, null);
});

test("確定性：同輸入同輸出；平手席次以 id 決勝", () => {
  const ps = [P("b", "welfare", 25), P("a", "welfare", 25), P("c", "pacifist", 25), P("d", "secular", 25)];
  const r1 = formCoalition(ps), r2 = formCoalition([...ps].reverse());
  assert.deepEqual(r1, r2); assert.equal(r1.primeId, "a");
});

test("空議會/全 0 席 → 失敗，不丟錯", () => {
  assert.equal(formCoalition([]).ok, false);
  assert.equal(formCoalition([P("a", "welfare", 0)]).ok, false);
});

test("半專制：現任自動組閣，即使沒過半；找不到現任退回最大黨", () => {
  const ps = [P("a", "welfare", 30), P("b", "militarist", 45), P("c", "secular", 25)];
  const r = semiCoalition(ps, "a");
  assert.equal(r.primeId, "a"); assert.equal(r.ok, true); assert.equal(r.single, false);
  assert.equal(semiCoalition(ps, "zzz").primeId, "b");
  assert.equal(semiCoalition([], null).ok, false);
});

test("政策折衷：加權平均，死區內棄權", () => {
  const tags: PolicyTag[] = [{ stance: "welfare", direction: 1 }];
  // 福利 40 贊成(+1)、和平 20 無關(0)：平均 0.667 → 贊成
  assert.equal(governmentStand([P("a", "welfare", 40), P("b", "pacifist", 20)], tags).stand, "for");
  // 福利 20 贊成、節流 20 反對(-1)：平均 0 → 棄權
  assert.equal(governmentStand([P("a", "welfare", 20), P("b", "fiscal_hawk", 20)], tags).stand, "abstain");
  // 福利 10 贊成、節流 40 反對：平均 -0.6 → 反對
  const g = governmentStand([P("a", "welfare", 10), P("b", "fiscal_hawk", 40)], tags);
  assert.equal(g.stand, "against"); assert.ok(g.score < -0.5);
  assert.equal(g.members.length, 2);
});

test("政策折衷：多標籤疊加不會讓單一極端黨壓過全部（態度夾在 -1~1）", () => {
  const tags: PolicyTag[] = [{ stance: "militarist", direction: 1 }, { stance: "pacifist", direction: -1 }];
  // 擴軍黨態度 = +1 +1 = 2 → 夾成 1；和平黨 = -1 + -1 → -1
  const g = governmentStand([P("a", "militarist", 10), P("b", "pacifist", 10)], tags);
  assert.equal(g.score, 0); assert.equal(g.stand, "abstain");
});

test("穩定度：單黨 1；同立場聯合高；剛過半比大幅過半脆弱；對立聯合極低", () => {
  assert.equal(coalitionStability([P("a", "welfare", 60)]), 1);
  const tight = coalitionStability([P("a", "welfare", 30), P("b", "pacifist", 21)]);
  const roomy = coalitionStability([P("a", "welfare", 45), P("b", "pacifist", 30)]);
  assert.ok(roomy > tight, `${roomy} 應 > ${tight}`);
  assert.ok(coalitionStability([P("a", "militarist", 30), P("b", "pacifist", 25)]) < 0.1);
  assert.equal(coalitionRisk(0.8), "low"); assert.equal(coalitionRisk(0.6), "mid"); assert.equal(coalitionRisk(0.3), "high");
});

test("裂解機率有上限、不為負", () => {
  assert.ok(defectChance(0, 0) <= MAX_DEFECT_CHANCE); assert.ok(defectChance(1, 1) >= 0);
  assert.ok(defectChance(0.2, 0.2) > defectChance(0.9, 0.9));
});

test("rollDefections：單黨/無總理不裂解；總理黨永不自己退出；rng 全 0 時所有夥伴都退出並倒閣", () => {
  assert.deepEqual(rollDefections([P("a", "welfare", 55)], "a", () => 0), { defectors: [], collapsed: false });
  assert.deepEqual(rollDefections([P("a", "welfare", 30), P("b", "pacifist", 25)], null, () => 0), { defectors: [], collapsed: false });
  const r = rollDefections([P("a", "welfare", 30), P("b", "pacifist", 25), P("c", "secular", 5)], "a", () => 0);
  assert.deepEqual(r.defectors.sort(), ["b", "c"]); assert.equal(r.collapsed, true);
  const none = rollDefections([P("a", "welfare", 30), P("b", "pacifist", 25)], "a", () => 0.999);
  assert.deepEqual(none, { defectors: [], collapsed: false });
});

test("rollDefections：退出的是小夥伴、剩下仍過半 → 不倒閣", () => {
  const ms = [P("a", "welfare", 45), P("b", "pacifist", 10), P("c", "secular", 3)];
  let n = 0; // 第一個夥伴(b)不退，第二個(c)退
  const r = rollDefections(ms, "a", () => (n++ === 0 ? 0.999 : 0));
  assert.deepEqual(r.defectors, ["c"]); assert.equal(r.collapsed, false);
});

test("tallyVoteWithGovernment：沒有聯合時與 tallyVote 完全等價", () => {
  const ps = [P("a", "welfare", 55), P("b", "militarist", 30), P("c", "secular", 15)];
  const tags: PolicyTag[] = [{ stance: "welfare", direction: 1 }];
  assert.deepEqual(tallyVoteWithGovernment(ps, tags, ["a"]), tallyVote(ps, tags));
  assert.deepEqual(tallyVoteWithGovernment(ps, tags, []), tallyVote(ps, tags));
});

test("tallyVoteWithGovernment：聯合內意見相左 → 政府棄權，由反對黨決定", () => {
  const ps = [P("a", "welfare", 26), P("b", "fiscal_hawk", 26), P("c", "militarist", 48)];
  const tags: PolicyTag[] = [{ stance: "welfare", direction: 1 }];
  // 單純 tallyVote：福利贊成 26、節流反對 26、擴軍棄權 → 平手 → 否決
  // 聯合版：福利+節流折衷成棄權(52 席棄權)，擴軍棄權 → 全員棄權 → 通過（議會無意見）
  const r = tallyVoteWithGovernment(ps, tags, ["a", "b"]);
  assert.equal(r.votes.length, 2); assert.equal(r.seatsAbstain, 100); assert.equal(r.passed, true);
  assert.match(r.votes[0]!.name, /執政聯盟/);
});

test("tallyVoteWithGovernment：政府贊成、反對黨席次較少 → 通過；席次總和守恆 100", () => {
  const ps = [P("a", "welfare", 30), P("b", "pacifist", 25), P("c", "fiscal_hawk", 45)];
  const tags: PolicyTag[] = [{ stance: "welfare", direction: 1 }];
  const r = tallyVoteWithGovernment(ps, tags, ["a", "b"]);
  assert.equal(r.seatsFor + r.seatsAgainst + r.seatsAbstain, 100);
  assert.equal(r.seatsFor, 55); assert.equal(r.seatsAgainst, 45); assert.equal(r.passed, true);
});

test("看守政府：贊成必須明顯多於反對才通過", () => {
  const ps = [P("a", "welfare", 52), P("b", "fiscal_hawk", 48)];
  const tags: PolicyTag[] = [{ stance: "welfare", direction: 1 }];
  assert.equal(tallyVoteWithGovernment(ps, tags, ["a"]).passed, true);
  // 52 vs 48：差 4 < 有表態 100 的 10% = 10 → 看守政府下不通過
  assert.equal(tallyVoteWithGovernment(ps, tags, ["a"], { caretaker: true }).passed, false);
  const big = [P("a", "welfare", 70), P("b", "fiscal_hawk", 30)];
  assert.equal(tallyVoteWithGovernment(big, tags, ["a"], { caretaker: true }).passed, true);
});

test("兩處折衷公式一致（coalition.governmentStand vs vote 內部）", () => {
  const stances: ParliamentStance[] = ["militarist", "pacifist", "fiscal_hawk", "welfare", "religious", "secular", "mercantile"];
  const tagSets: PolicyTag[][] = [
    [{ stance: "welfare", direction: 1 }], [{ stance: "militarist", direction: -1 }],
    [{ stance: "religious", direction: 1 }, { stance: "mercantile", direction: -1 }], [],
  ];
  for (const s1 of stances) for (const s2 of stances) for (const tags of tagSets) {
    if (s1 === s2) continue;
    const ms = [P("x", s1, 30), P("y", s2, 25)];
    const rest = P("z", "mercantile", 45);
    const direct = governmentStand(ms, tags).stand;
    const viaVote = tallyVoteWithGovernment([...ms, rest], tags, ["x", "y"]).votes[0]!.stand;
    assert.equal(viaVote, direct, `${s1}+${s2} ${JSON.stringify(tags)}`);
  }
});
