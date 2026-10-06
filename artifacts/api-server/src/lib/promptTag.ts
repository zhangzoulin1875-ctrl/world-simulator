/**
 * 玩家文字放進 AI prompt 的標籤內之前,先剝掉所有能「跳出資料區」的標籤字串。
 *
 * 單次 replace 不夠:`</rep</report>ort>` 剝掉內層後會重新拼出 `</report>`;
 * `</REPORT >`、`< / report>` 這類帶空白的寫法也要擋。所以:
 *  1. 先把全形角括號與零寬字元正規化,避免繞過;
 *  2. 標籤內允許任意空白;
 *  3. 反覆剝除直到文字不再變化(有上限,避免惡意長字串拖垮)。
 */
export function stripPromptTag(text: string, tag: string): string {
  const name = tag.replace(/[^a-z_]/gi, "");
  const re = new RegExp(`<\\s*/?\\s*${name}\\s*>`, "gi");
  let out = text
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/＜/g, "<")
    .replace(/＞/g, ">");
  for (let i = 0; i < 20; i++) {
    const next = out.replace(re, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
