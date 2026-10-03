import { strict as assert } from "node:assert";
import test from "node:test";
import {
  parseWorldProposal,
  validateWorldProposal,
  applyPlanToControls,
  WorldProposalError,
  type WorldProposal,
  type WorldProposalContext,
  type RegionControlRow,
  type NormalizedWorldPlan,
} from "./worldSim";

const PLAYER_A = "11111111-1111-1111-1111-111111111111";
const NPC_A = "22222222-2222-2222-2222-222222222222";
const NPC_B = "33333333-3333-3333-3333-333333333333";
const UNKNOWN = "99999999-9999-9999-9999-999999999999";

function ctx(
  overrides: Partial<WorldProposalContext> = {},
): WorldProposalContext {
  return {
    protectedNationIds: new Set([PLAYER_A]),
    editableNationIds: new Set([NPC_A, NPC_B]),
    validRegionIds: new Set([1, 2, 3, 4, 5]),
    currentControls: [],
    ...overrides,
  };
}

test("parseWorldProposal 接受合法結構", () => {
  const raw = {
    summary: "生成一個古典時代小國",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "測試國",
        techEraMilitary: "classical",
        regions: [{ regionId: 1, percent: 100 }],
      },
    ],
  };
  const p = parseWorldProposal(raw);
  assert.equal(p.operations.length, 1);
});

test("parseWorldProposal 拒絕未知時代 slug", () => {
  const raw = {
    summary: "壞的",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "測試國",
        techEraMilitary: "stone_age",
        regions: [{ regionId: 1, percent: 100 }],
      },
    ],
  };
  assert.throws(() => parseWorldProposal(raw));
});

test("parseWorldProposal 拒絕 createNpc 無地區", () => {
  const raw = {
    summary: "壞的",
    operations: [
      { op: "createNpc", tempId: "n1", name: "測試國", regions: [] },
    ],
  };
  assert.throws(() => parseWorldProposal(raw));
});

test("validateWorldProposal 正常新增 NPC 回傳正規化計畫", () => {
  const proposal: WorldProposal = {
    summary: "生成兩個小國",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "甲國",
        government: "君主專制",
        techEraMilitary: "classical",
        regions: [{ regionId: 1, percent: 60 }],
      },
      {
        op: "createNpc",
        tempId: "n2",
        name: "乙國",
        regions: [{ regionId: 1, percent: 40 }],
      },
    ],
  };
  const plan = validateWorldProposal(proposal, ctx());
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.deletes.length, 0);
});

test("validateWorldProposal 拒絕任何指向玩家國家的操作（redraw world 情境）", () => {
  const proposal: WorldProposal = {
    summary: "重畫整個世界",
    operations: [
      { op: "deleteNation", nationId: NPC_A },
      { op: "updateNation", nationId: PLAYER_A, name: "被搶的玩家國" },
    ],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx()),
    (e: unknown) =>
      e instanceof WorldProposalError && /玩家國家/.test((e as Error).message),
  );
});

test("validateWorldProposal 拒絕刪除玩家國家", () => {
  const proposal: WorldProposal = {
    summary: "刪玩家",
    operations: [{ op: "deleteNation", nationId: PLAYER_A }],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx()),
    (e: unknown) => e instanceof WorldProposalError,
  );
});

test("validateWorldProposal 拒絕指向未知國家", () => {
  const proposal: WorldProposal = {
    summary: "未知國",
    operations: [{ op: "updateNation", nationId: UNKNOWN, name: "X" }],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx()),
    (e: unknown) =>
      e instanceof WorldProposalError && /不存在或無法編輯/.test((e as Error).message),
  );
});

test("validateWorldProposal 拒絕重複 tempId", () => {
  const proposal: WorldProposal = {
    summary: "重複",
    operations: [
      {
        op: "createNpc",
        tempId: "dup",
        name: "甲",
        regions: [{ regionId: 1, percent: 10 }],
      },
      {
        op: "createNpc",
        tempId: "dup",
        name: "乙",
        regions: [{ regionId: 2, percent: 10 }],
      },
    ],
  };
  assert.throws(() => validateWorldProposal(proposal, ctx()));
});

test("validateWorldProposal 拒絕同一國家被多個操作指向", () => {
  const proposal: WorldProposal = {
    summary: "重複指向",
    operations: [
      { op: "updateNation", nationId: NPC_A, name: "X" },
      { op: "deleteNation", nationId: NPC_A },
    ],
  };
  assert.throws(() => validateWorldProposal(proposal, ctx()));
});

test("validateWorldProposal 拒絕不存在的地區代號", () => {
  const proposal: WorldProposal = {
    summary: "壞地區",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "甲",
        regions: [{ regionId: 999, percent: 50 }],
      },
    ],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx()),
    (e: unknown) =>
      e instanceof WorldProposalError && /不存在/.test((e as Error).message),
  );
});

test("validateWorldProposal 拒絕同國重複指派同一地區", () => {
  const proposal: WorldProposal = {
    summary: "重複地區",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "甲",
        regions: [
          { regionId: 1, percent: 50 },
          { regionId: 1, percent: 20 },
        ],
      },
    ],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx()),
    (e: unknown) =>
      e instanceof WorldProposalError && /重複指派/.test((e as Error).message),
  );
});

test("validateWorldProposal Σ>100（含玩家既有掌控）時拒絕", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: PLAYER_A, percent: 60 },
  ];
  const proposal: WorldProposal = {
    summary: "擠壓玩家地盤",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "甲",
        regions: [{ regionId: 1, percent: 50 }],
      },
    ],
  };
  assert.throws(
    () => validateWorldProposal(proposal, ctx({ currentControls: current })),
    (e: unknown) =>
      e instanceof WorldProposalError && /超過 100/.test((e as Error).message),
  );
});

test("validateWorldProposal 允許在玩家未占滿的地區填入剩餘空間", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: PLAYER_A, percent: 60 },
  ];
  const proposal: WorldProposal = {
    summary: "填空",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "甲",
        regions: [{ regionId: 1, percent: 40 }],
      },
    ],
  };
  const plan = validateWorldProposal(
    proposal,
    ctx({ currentControls: current }),
  );
  assert.equal(plan.creates.length, 1);
});

test("刪除國家會釋出其掌控，Σ 重新計算不超標", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: NPC_A, percent: 80 },
    { regionId: 1, nationId: PLAYER_A, percent: 20 },
  ];
  const proposal: WorldProposal = {
    summary: "NPC_A 崩潰，NPC_B 接手",
    operations: [
      { op: "deleteNation", nationId: NPC_A },
      {
        op: "updateNation",
        nationId: NPC_B,
        regions: [{ regionId: 1, percent: 80 }],
      },
    ],
  };
  const plan = validateWorldProposal(
    proposal,
    ctx({
      editableNationIds: new Set([NPC_A, NPC_B]),
      currentControls: current,
    }),
  );
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.updates.length, 1);
});

test("applyPlanToControls：更新（全量替換）會先移除該國舊列再加新列", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: NPC_A, percent: 100 },
    { regionId: 2, nationId: NPC_A, percent: 100 },
  ];
  const plan: NormalizedWorldPlan = {
    summary: "",
    creates: [],
    updates: [{ nationId: NPC_A, regions: [{ regionId: 2, percent: 50 }] }],
    deletes: [],
  };
  const sums = applyPlanToControls(current, plan);
  // 地區 1 的舊列被移除（未在新列中） → 0（不出現於 map）
  assert.equal(sums.get(1) ?? 0, 0);
  assert.equal(sums.get(2), 50);
});

test("applyPlanToControls：無 regions 的更新不動領土", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: NPC_A, percent: 70 },
  ];
  const plan: NormalizedWorldPlan = {
    summary: "",
    creates: [],
    updates: [{ nationId: NPC_A, name: "改名不改地" }],
    deletes: [],
  };
  const sums = applyPlanToControls(current, plan);
  assert.equal(sums.get(1), 70);
});

test("applyPlanToControls：玩家列永遠原封保留並計入總和", () => {
  const current: RegionControlRow[] = [
    { regionId: 1, nationId: PLAYER_A, percent: 30 },
    { regionId: 1, nationId: NPC_A, percent: 70 },
  ];
  const plan: NormalizedWorldPlan = {
    summary: "",
    creates: [],
    updates: [],
    deletes: [NPC_A],
  };
  const sums = applyPlanToControls(current, plan);
  // NPC_A 被刪除 → 只剩玩家 30
  assert.equal(sums.get(1), 30);
});

test("validateWorldProposal：提供 maxTechEraSlug 時，NPC 科技指標夾到世界時代", () => {
  const proposal: WorldProposal = {
    summary: "超前時代的 NPC",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "未來國",
        techEraMilitary: "future", // 超過世界時代 → 夾到 renaissance
        techEraSocial: "classical", // 未超過 → 原樣
        // techEraProduction 省略 → 保持 undefined（建立時預設 null）
        regions: [{ regionId: 1, percent: 100 }],
      },
    ],
  };
  const plan = validateWorldProposal(
    proposal,
    ctx({ maxTechEraSlug: "renaissance" }),
  );
  assert.equal(plan.creates[0].techEraMilitary, "renaissance");
  assert.equal(plan.creates[0].techEraSocial, "classical");
  assert.equal(plan.creates[0].techEraProduction, undefined);
});

test("validateWorldProposal：更新時 undefined 保持不變、null 保持清除，超前值夾取", () => {
  const proposal: WorldProposal = {
    summary: "更新 NPC 科技",
    operations: [
      {
        op: "updateNation",
        nationId: NPC_A,
        techEraMilitary: "future", // 夾到 industrial
        techEraSocial: null, // 明確清除 → 沿用世界時代
        // techEraProduction 省略 → undefined（不變）
      },
    ],
  };
  const plan = validateWorldProposal(
    proposal,
    ctx({ maxTechEraSlug: "industrial" }),
  );
  assert.equal(plan.updates[0].techEraMilitary, "industrial");
  assert.equal(plan.updates[0].techEraSocial, null);
  assert.equal(plan.updates[0].techEraProduction, undefined);
});

test("validateWorldProposal：省略 maxTechEraSlug 時科技指標原樣通過", () => {
  const proposal: WorldProposal = {
    summary: "純結構驗證",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "先進國",
        techEraMilitary: "future",
        regions: [{ regionId: 1, percent: 100 }],
      },
    ],
  };
  const plan = validateWorldProposal(proposal, ctx());
  assert.equal(plan.creates[0].techEraMilitary, "future");
});
