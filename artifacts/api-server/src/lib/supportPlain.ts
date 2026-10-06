/**
 * 把客服回答裡「玩家看不懂的程式字樣」去掉的保底處理（純函式）。
 * 主要靠 prompt 與匿名依據讓 AI 自己講人話；這裡只處理仍然漏出的：
 *  - 程式碼區塊 ```...``` 整段移除
 *  - 檔名（xxx.ts / xxx.tsx / xxx.md、含路徑）
 *  - 行內程式碼 `...`：像識別字／程式式子的整段拿掉；若是一般中文詞則只去掉反引號
 * 不改動其他排版（不強制任何格式）。
 */

const FENCE_RE = /```[\s\S]*?```/g;
const FILE_RE = /(?:[\w@.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|md|json|sql)\b(?::\d+(?:-\d+)?)?/gi;
const INLINE_RE = /`([^`\n]{1,120})`/g;

/** 像程式碼的行內片段：駝峰／底線識別字、含括號呼叫、含運算符號與英文的式子。 */
export function looksLikeCode(s: string): boolean {
  const t = s.trim();
  if (/[\u4e00-\u9fff]/.test(t) && !/[A-Za-z_]{3,}[A-Za-z0-9_.]*\s*[(=]/.test(t)) return false; // 中文詞
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) return true; // camelCase
  if (/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(t)) return true; // snake_case / CONST
  if (/[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(t)) return true; // 函式呼叫
  if (/[=<>+\-*/]/.test(t) && /[A-Za-z]{2,}/.test(t)) return true; // 式子
  if (/^[A-Za-z0-9_.]+\.[a-z]{2,4}$/.test(t)) return true; // 檔名
  return false; // 單一全小寫／全大寫英文詞（alliance、GDP）視為一般詞，只去反引號
}

/** 玩家看得懂的「實質字數」：只算中文字與數字（英文識別字不計，免得被長識別字扭曲比例）。 */
function substance(t: string): number {
  return (t.match(/[\u4e00-\u9fff0-9]/g) ?? []).length;
}

/** 括號裡只剩出處／術語的補充（如「（詳見 xxx.ts）」「(見 calcGrowth())」）先整段拿掉。 */
const PAREN_REF_RE = /[（(][^（）()]{0,80}?(?:\w+\.(?:tsx?|jsx?|md|json|sql)\b|`[^`]+`)[^（）()]{0,80}?[）)]/g;

/** 清掉因移除而殘留的空括號／孤立標點／多餘空白。 */
function tidy(t: string): string {
  return t
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/「\s*」/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。、；：！？])/g, "$1")
    .replace(/([，、；])\s*([。！？])/g, "$2")
    .replace(/^[，、；：]+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 單一句子去術語；若刪掉後句子殘缺，整句捨棄，不留破碎的字。
 * 殘缺的判斷：剩下的中文字不足以撐起一句話。被刪的術語越多，要求的剩餘字數越高
 * （門檻 = 8 + 4 × 術語個數），所以「一句話被 4 個術語撐起來」會被丟，「只多一個括號出處」則保留。
 */
function cleanSentence(sentence: string): string {
  if (substance(sentence) === 0) return sentence;
  let removed = 0;
  const count = <T extends string>(_m: T) => {
    removed++;
    return "";
  };
  let t = sentence.replace(PAREN_REF_RE, count);
  t = t.replace(INLINE_RE, (_m, inner: string) => {
    if (looksLikeCode(inner)) {
      removed++;
      return "";
    }
    return inner;
  });
  t = t.replace(FILE_RE, count);
  if (removed === 0) return t === sentence ? sentence : tidy(t); // 只拿掉了一般詞的反引號
  if (substance(t) < 8 + 4 * removed) return "";
  return tidy(t);
}

export function stripJargon(answer: string): string {
  const noFence = answer.replace(FENCE_RE, "");
  // 逐行、逐句處理：保留原本的換行與條列結構
  const lines = noFence.split("\n").map((line) => {
    const pieces = line.match(/[^。！？!?]+[。！？!?]?/g) ?? [line];
    return pieces.map(cleanSentence).join("");
  });
  let out = lines.join("\n");
  // 條列只剩編號（整行內容被丟掉）→ 移除該行
  out = out.replace(/^\s*(?:[-*•]|\d+[.、)])\s*$/gm, "");
  return tidy(out).trim();
}
