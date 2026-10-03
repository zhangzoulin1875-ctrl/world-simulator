import { strict as assert } from "node:assert";
import test from "node:test";
import { extractWorldProposalJson } from "./worldSimAi";

const VALID = {
  summary: "在東亞新增一個古典時代小國",
  operations: [
    {
      op: "createNpc",
      tempId: "n1",
      name: "測試國",
      leaderName: "測試王",
      government: null,
      techEraMilitary: "classical",
      regions: [{ regionId: 1, percent: 100 }],
    },
  ],
};

test("extractWorldProposalJson 接受純 JSON 字串", () => {
  const proposal = extractWorldProposalJson(JSON.stringify(VALID));
  assert.equal(proposal.summary, "在東亞新增一個古典時代小國");
  assert.equal(proposal.operations.length, 1);
  const op = proposal.operations[0];
  assert.equal(op.op, "createNpc");
});

test("extractWorldProposalJson 去除 ```json code fence", () => {
  const fenced = "```json\n" + JSON.stringify(VALID) + "\n```";
  const proposal = extractWorldProposalJson(fenced);
  assert.equal(proposal.operations.length, 1);
});

test("extractWorldProposalJson 去除無語言標籤的 ``` fence 與前後空白", () => {
  const fenced = "  ```\n" + JSON.stringify(VALID) + "\n```  ";
  const proposal = extractWorldProposalJson(fenced);
  assert.equal(proposal.summary, VALID.summary);
});

test("extractWorldProposalJson 非 JSON 文字 → 丟出例外", () => {
  assert.throws(() => extractWorldProposalJson("這不是 JSON"));
});

test("extractWorldProposalJson 結構不符（createNpc 無地區）→ 丟出例外", () => {
  const bad = {
    summary: "壞提案",
    operations: [{ op: "createNpc", tempId: "n1", name: "無地區國", regions: [] }],
  };
  assert.throws(() => extractWorldProposalJson(JSON.stringify(bad)));
});

test("extractWorldProposalJson 結構不符（未知時代 slug）→ 丟出例外", () => {
  const bad = {
    summary: "壞提案",
    operations: [
      {
        op: "createNpc",
        tempId: "n1",
        name: "未來國",
        techEraMilitary: "not-a-real-era",
        regions: [{ regionId: 1, percent: 50 }],
      },
    ],
  };
  assert.throws(() => extractWorldProposalJson(JSON.stringify(bad)));
});
