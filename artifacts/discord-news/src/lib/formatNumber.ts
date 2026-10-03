/** 人口以中文單位顯示：億 / 萬（保留假精度以外的可讀性）。 */
export function formatPopulation(n: number): string {
  if (n >= 1e8) {
    const v = n / 1e8;
    return `${v >= 100 ? Math.round(v).toLocaleString("zh-TW") : v.toFixed(2).replace(/\.?0+$/, "")} 億`;
  }
  if (n >= 1e4) {
    const v = n / 1e4;
    return `${v >= 100 ? Math.round(v).toLocaleString("zh-TW") : v.toFixed(1).replace(/\.0$/, "")} 萬`;
  }
  return n.toLocaleString("zh-TW");
}
