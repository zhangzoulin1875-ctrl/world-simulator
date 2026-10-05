import { GOVERNMENTS } from "../governments";
import { ERAS } from "../mapRegionEras";
import { isCostEffect, type FocusDef } from "./types";

/**
 * 目錄驗證(回傳問題清單,空陣列=通過)。測試與啟動時都可呼叫。
 * 這些規則就是「反流水帳」的強制機制:
 *  - 每個國策至少一項代價
 *  - 分岔群組至少兩個選項
 *  - 里程碑必須解鎖能力/轉型
 *  - 引用必須存在、前置不可成環
 *  - 政體/時代 slug 必須有效
 *  - 成本與回合在合理範圍
 */
export function validateCatalog(defs: readonly FocusDef[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, FocusDef>();
  for (const d of defs) {
    if (byId.has(d.id)) problems.push(`重複 id:${d.id}`);
    byId.set(d.id, d);
  }

  const govSlugs = new Set(GOVERNMENTS.map((g) => g.slug));
  const eraSlugs = new Set((ERAS as readonly { slug: string }[]).map((e) => e.slug));

  const groups = new Map<string, string[]>();

  for (const d of defs) {
    const tag = `[${d.id}]`;
    if (!/^[a-z]+(\.[a-z0-9_]+)+$/.test(d.id)) problems.push(`${tag} id 格式應為 領域.名稱`);
    if (!d.title.trim() || !d.description.trim()) problems.push(`${tag} 缺標題或敘述`);
    if (!Number.isInteger(d.cost) || d.cost < 1 || d.cost > 200) problems.push(`${tag} cost 需為 1-200 整數`);
    if (!Number.isInteger(d.turns) || d.turns < 1 || d.turns > 30) problems.push(`${tag} turns 需為 1-30 整數`);

    // 規則 1:每個國策必有代價
    if (!d.effects.some(isCostEffect)) problems.push(`${tag} 沒有任何代價(至少一項負面效果)`);

    // 規則 3:里程碑必須解鎖能力或轉型
    if (d.milestone && !d.effects.some((e) => e.kind === "unlock" || e.kind === "transition" || e.kind === "revolution")) {
      problems.push(`${tag} 標為里程碑但沒有 unlock/transition/revolution 效果`);
    }

    // 轉型國策必須在 regime 領域,且目標政體有效
    for (const e of d.effects) {
      if (e.kind === "transition") {
        if (d.domain !== "regime") problems.push(`${tag} transition 只能出現在 regime 領域`);
        if (!govSlugs.has(e.toGovernment)) problems.push(`${tag} 轉型目標政體不存在:${e.toGovernment}`);
        if (!d.milestone) problems.push(`${tag} 轉型國策必須是里程碑`);
      }
    }

    for (const e of d.effects) {
      if (e.kind === "revolution") {
        if (d.domain !== "regime") problems.push(`${tag} revolution 只能出現在 regime 領域`);
        if (!d.milestone) problems.push(`${tag} 革命國策必須是里程碑`);
        if (!(e.landShare > 0 && e.landShare < 1)) problems.push(`${tag} 革命 landShare 需介於 0~1`);
        if (d.effects.some((x) => x.kind === "transition")) problems.push(`${tag} 不可同時有 transition 與 revolution`);
      }
    }

    for (const g of d.governments ?? []) if (!govSlugs.has(g)) problems.push(`${tag} 政體 slug 無效:${g}`);
    if (d.minEra && !eraSlugs.has(d.minEra)) problems.push(`${tag} minEra 無效:${d.minEra}`);

    for (const r of [...d.requires, ...(d.requiresAny ?? []), ...(d.excludes ?? [])]) {
      if (!byId.has(r)) problems.push(`${tag} 引用不存在的國策:${r}`);
      if (r === d.id) problems.push(`${tag} 不可引用自己`);
    }

    if (d.exclusiveGroup) {
      const list = groups.get(d.exclusiveGroup) ?? [];
      list.push(d.id);
      groups.set(d.exclusiveGroup, list);
    }
  }

  // 規則 2:分岔群組至少兩個選項
  for (const [g, ids] of groups) {
    if (ids.length < 2) problems.push(`互斥群組 ${g} 只有 ${ids.length} 個選項(需 >= 2)`);
  }

  // 規則 4:前置鏈不可成環(DFS;requires 與 requiresAny 都算邊)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    const c = color.get(id) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      problems.push(`前置成環:${[...path, id].join(" → ")}`);
      return;
    }
    color.set(id, GRAY);
    const d = byId.get(id);
    if (d) for (const r of [...d.requires, ...(d.requiresAny ?? [])]) if (byId.has(r)) visit(r, [...path, id]);
    color.set(id, BLACK);
  };
  for (const id of byId.keys()) visit(id, []);

  return problems;
}

/** 以群組查互斥對象:回傳某國策的「同群組其他成員」。 */
export function exclusiveSiblings(defs: readonly FocusDef[], def: FocusDef): string[] {
  const out = new Set<string>(def.excludes ?? []);
  if (def.exclusiveGroup) {
    for (const d of defs) if (d.exclusiveGroup === def.exclusiveGroup && d.id !== def.id) out.add(d.id);
  }
  return [...out];
}
