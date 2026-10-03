export function signed(v: number): string {
  // 最多顯示到小數點第一位，避免加減成／滿意度等數據出現一長串小數。
  const r = Math.round(v * 10) / 10;
  return r > 0 ? `+${r}` : String(r);
}

export const STATUS_LABELS: Record<string, string> = {
  active: "生效中",
  expired: "已結束",
  repealed: "已廢除",
  failed: "失敗",
};

export const TARGET_LABELS: Record<string, string> = {
  satisfaction: "滿意度",
  satisfactionLaw: "農民滿意度",
  satisfactionCulture: "工人滿意度",
  satisfactionReligion: "教士滿意度",
  satisfactionRights: "貴族(資本家)滿意度",
  satisfactionMilitary: "軍方滿意度",
  militaryObedience: "軍方服從度",
  stability: "穩定度",
  production: "生產力",
  tech: "科技",
  populationGrowth: "人口增長",
};

export function modifierText(m: { target: string; value: number }): string {
  const label = TARGET_LABELS[m.target] ?? m.target;
  const isPct =
    m.target === "production" ||
    m.target === "tech" ||
    m.target === "populationGrowth";
  return `${label} ${signed(m.value)}${isPct ? "%" : ""}`;
}
