/**
 * 國際組織 AI 決策(純邏輯部分:prompt 建構、輸出解析、護欄)。無 DB、無網路。
 *
 * 原則(2026-10-07 定案):
 *  - AI 只能從固定動作清單挑「動作+目標」,效果數字全由 core.ts 公式決定。
 *  - 國名、領導人、玩家名稱一律不進 prompt:國家以匿名代號(N1、N2…)出現,只給分級後的局勢描述。
 *  - AI 輸出一律經解析 + validateDecisions(門檻、冷卻、上限、重複);任何一步不合法 → 該項剔除,全剔除 = 按兵不動。
 *  - 護欄:不得「無理由」針對玩家國。玩家國要被選上,動盪度必須達到規則版門檻(RULE_UNREST_THRESHOLD)。
 */
import {
  ACTION_LABELS, ACTION_MIN_INFLUENCE, MAX_TARGETS_PER_DECISION, ORG_ACTIONS, RULE_UNREST_THRESHOLD, TARGET_COOLDOWN_TURNS,
  actionAllowedOn, unrest, unlockedActions, validateDecisions,
  type Decision, type DecisionContext, type NationSituation, type OrgAction,
} from "./core";

/** 提供給 AI 的候選國上限(取動盪度最高者),控制 prompt 長度與 token。 */
export const AI_MAX_CANDIDATES = 12;

export interface OrgBrief {
  /** 組織意識形態(給 AI 的語氣依據)。 */
  ideology: string;
  eraSlug: string;
}

export interface AnonNation { code: string; nationId: string }

const band = (v: number | null, labels: [string, string, string, string]): string => {
  if (v === null) return "無議會";
  return v < 25 ? labels[0] : v < 50 ? labels[1] : v < 75 ? labels[2] : labels[3];
};

/** 把局勢描述成分級文字(不給精確數字,避免 AI 對數值過度擬合,也不洩漏任何名稱)。 */
export function describeNation(code: string, n: NationSituation): string {
  const sat = band(n.parliamentSat, ["議會極度不滿", "議會不滿", "議會尚可", "議會滿意"]);
  const stab = n.stability < 25 ? "局勢動盪" : n.stability < 50 ? "局勢不穩" : n.stability < 75 ? "局勢尚穩" : "局勢穩固";
  const left = n.radicalSeatShare >= 0.3 ? "左翼黨勢大" : n.radicalSeatShare >= 0.1 ? "左翼黨有基礎" : "幾乎沒有左翼黨";
  return `${code}:${sat};${stab};${left}${n.atWar ? ";交戰中" : ""}`;
}

/** 建 prompt 與代號對照表。候選 = 非內戰國中動盪度最高的 AI_MAX_CANDIDATES 個(平手以 nationId 決勝,確定性)。 */
export function buildDecisionPrompt(ctx: DecisionContext, brief: OrgBrief): { prompt: string; anon: AnonNation[] } {
  const ranked = [...ctx.nations]
    .filter((n) => !n.inCivilWar && !n.aligned)
    .sort((a, b) => unrest(b) - unrest(a) || a.nationId.localeCompare(b.nationId))
    .slice(0, AI_MAX_CANDIDATES);
  const anon: AnonNation[] = ranked.map((n, i) => ({ code: `N${i + 1}`, nationId: n.nationId }));
  const lines = ranked.map((n, i) => describeNation(`N${i + 1}`, n));
  const usable = unlockedActions(ctx.influence).filter((a) => a !== "idle");
  const actionLines = usable.map((a) => `- ${a}(${ACTION_LABELS[a]})`).join("\n");
  const subvertRule = usable.includes("subvert")
    ? `\n- subvert 只能用於「議會極度不滿」且「左翼黨勢大」或「左翼黨有基礎」的國家`
    : "";
  const prompt = [
    `你是一個世界級的${brief.ideology === "red" ? "左翼革命" : "意識形態"}國際組織的戰略決策者。時代:${brief.eraSlug}。你目前的影響力${ctx.influence >= 60 ? "強大" : ctx.influence >= 30 ? "成長中" : "微弱"}。`,
    `以下是各國局勢(已匿名),請決定這一輪要對哪些國家採取什麼行動,最多 ${MAX_TARGETS_PER_DECISION} 個目標,也可以選擇不行動(穩定的國家不要動)。`,
    "",
    "局勢:",
    ...lines,
    "",
    "你目前能用的行動:",
    actionLines || "- (影響力太低,只能宣傳)",
    "",
    "規則:",
    `- 只能從上面列出的行動中挑;同一個國家只能挑一個行動;每個國家 ${TARGET_COOLDOWN_TURNS} 回合內不能被重複針對`,
    "- 局勢穩定的國家不要出手;把資源放在最有機會的國家",
    "- 影響力低時行動要克制,優先宣傳" + subvertRule,
    "",
    '只輸出 JSON 陣列,不要任何說明文字。格式:[{"target":"N1","action":"propaganda"}]。不想行動就輸出 []。',
  ].join("\n");
  return { prompt, anon };
}

/**
 * 解析 AI 輸出。容忍外層 markdown 圍欄與前後說明;抓第一個 JSON 陣列。
 * 找不到陣列 → 丟錯(上層退回規則版);陣列內壞項目 → 略過該項。
 */
export function parseDecisionOutput(raw: string, anon: readonly AnonNation[]): Decision[] {
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array in AI output");
  let arr: unknown;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("AI output is not valid JSON"); }
  if (!Array.isArray(arr)) throw new Error("AI output is not an array");
  const byCode = new Map(anon.map((a) => [a.code.toUpperCase(), a.nationId]));
  const out: Decision[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const code = typeof o.target === "string" ? o.target.trim().toUpperCase() : "";
    const action = typeof o.action === "string" ? (o.action.trim().toLowerCase() as OrgAction) : ("" as OrgAction);
    const nationId = byCode.get(code);
    if (!nationId || !ORG_ACTIONS.includes(action)) continue;
    out.push({ targetNationId: nationId, action });
  }
  return out;
}

/**
 * 護欄 + 驗證:玩家國需動盪度達門檻才可被選;其餘交給 validateDecisions(門檻/冷卻/上限/重複)。
 * 全被剔除 → 空陣列(按兵不動)。
 */
export function guardDecisions(raw: readonly Decision[], ctx: DecisionContext): Decision[] {
  const byId = new Map(ctx.nations.map((n) => [n.nationId, n]));
  const reasonable = raw.filter((d) => {
    const n = d.targetNationId ? byId.get(d.targetNationId) : undefined;
    if (!n) return false;
    return !n.isPlayer || unrest(n) >= RULE_UNREST_THRESHOLD;
  });
  return validateDecisions(reasonable, ctx);
}

/** AI 總結果 → 最終決策。AI 沒給任何合法項 → 空陣列,由上層決定要不要補規則版。 */
export function resolveAiDecisions(raw: string, anon: readonly AnonNation[], ctx: DecisionContext): Decision[] {
  return guardDecisions(parseDecisionOutput(raw, anon), ctx);
}

export { ACTION_MIN_INFLUENCE, actionAllowedOn };
