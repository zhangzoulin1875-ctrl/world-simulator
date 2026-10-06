/**
 * AI 客服回答的事後驗證（防胡編）。純函式，不呼叫 AI。
 *
 * 檢查兩件事：
 *  1. 引用的出處 [檔名] 必須真的在本次提供的依據裡（或是 [遊戲知識]）。
 *  2. 回答裡的「具體數字」必須能在本次提供的依據（程式碼片段＋遊戲知識＋玩家問題）裡找到。
 * 任何一項不通過 → 回傳問題清單，由呼叫端要求 AI 修正或加上免責。
 */
export interface VerifyResult {
  ok: boolean;
  badCitations: string[];
  unsupportedNumbers: string[];
}

const CITE_RE = /\[([^\[\]\n]{1,80})\]/g;
// 常見、不需要出處的數字：0～10、1/2/3 回合之類的小數字（太容易誤殺）、年份以外的 100 與 50 這類刻度
const TRIVIAL = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "100"]);

/** 取出回答中標的出處（排除 [遊戲知識] 與純符號）。 */
export function extractCitations(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(CITE_RE)) {
    const c = m[1]!.trim();
    if (c === "遊戲知識" || c === "推測") continue;
    if (!/[A-Za-z]/.test(c) && !c.includes("/") && !c.includes(".")) continue; // 不像檔名
    out.push(c);
  }
  return [...new Set(out)];
}

/** 把出處正規化成檔名（去路徑、去行號、小寫）。 */
function baseName(c: string): string {
  return (c.split(/[\\/]/).pop() ?? c).replace(/[（(][^)）]*[)）]/g, "").replace(/:\d+(-\d+)?$/, "").trim().toLowerCase();
}

/** 取出回答中的「具體數字」（含小數、百分比、千分位），略過年代與微小數字。 */
export function extractNumbers(answer: string): string[] {
  const stripped = answer.replace(CITE_RE, " "); // 出處裡的數字不算
  const out = new Set<string>();
  for (const m of stripped.matchAll(/(\d[\d,]*\.?\d*)\s*(%|％)?/g)) {
    const raw = m[1]!.replace(/,/g, "").replace(/\.$/, "");
    if (!raw || TRIVIAL.has(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

/** 數字是否以「完整數字」出現在語料中（37 不應被 373 或 1370 命中）。 */
export function hasNumber(corpus: string, n: string): boolean {
  const esc = n.replace(/\./g, "\\.");
  return new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`).test(corpus);
}

export function verifyAnswer(answer: string, evidence: { codePaths: string[]; corpus: string }): VerifyResult {
  const paths = new Set(evidence.codePaths.map((p) => baseName(p)));
  const badCitations = extractCitations(answer).filter((c) => {
    const b = baseName(c);
    return !paths.has(b) && ![...paths].some((p) => p.endsWith(b) || b.endsWith(p));
  });
  const corpus = evidence.corpus.replace(/,/g, "");
  const unsupportedNumbers = extractNumbers(answer).filter((n) => {
    if (hasNumber(corpus, n)) return false;
    // 4 位數且像年份的不查
    if (/^(1[0-9]|20)\d{2}$/.test(n)) return false;
    // 小數：容許依據裡只有等價的整數百分比（0.06 ↔ 6）
    const f = Number(n);
    if (!Number.isNaN(f) && f > 0 && f < 1) return !hasNumber(corpus, String(Math.round(f * 100)));
    return true;
  });
  return { ok: badCitations.length === 0 && unsupportedNumbers.length === 0, badCitations, unsupportedNumbers };
}

/** 把驗證不過的原因組成給 AI 的修正指示。 */
export function buildFixInstruction(v: VerifyResult): string {
  const lines: string[] = ["你上一版回答有下列問題，請修正後重新輸出完整回答："];
  if (v.badCitations.length > 0) lines.push(`- 你引用了依據中不存在的出處：${v.badCitations.join("、")}。只能引用【程式碼依據】標頭裡真的出現的檔名，或 [遊戲知識]。`);
  if (v.unsupportedNumbers.length > 0) lines.push(`- 下列數字在依據與遊戲知識中找不到，疑似編造：${v.unsupportedNumbers.join("、")}。請刪掉，或改用「提高／降低」這類不含數字的描述。`);
  lines.push("其他內容若沒有依據也一併刪除。不要道歉或說明修正過程，直接輸出修正後的回答。");
  return lines.join("\n");
}

/** 修正後仍不過時的保底處理：移除不被支持的數字與出處，並加上提醒，確保不輸出編造內容。 */
export function sanitizeAnswer(answer: string, v: VerifyResult): string {
  let out = answer;
  for (const c of v.badCitations) out = out.split(`[${c}]`).join("");
  for (const n of v.unsupportedNumbers) {
    const re = new RegExp(`${n.replace(/\./g, "\\.")}\\s*(%|％)?`, "g");
    out = out.replace(re, "（數值待確認）");
  }
  return `${out.trim()}\n\n（以上部分數值我無法在遊戲資料中確認，已略去；細節請向管理員確認。）`;
}
