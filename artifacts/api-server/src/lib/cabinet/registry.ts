import type { CabinetDomain, CabinetDomainModule } from "./types";
import { interiorModule } from "./domains/interior";
import { militaryModule } from "./domains/military";
import { diplomacyModule } from "./domains/diplomacy";

/**
 * Task #242 — 領域模組登錄表。匯總三個獨立領域模組，供 API／回合引擎以
 * domain 為 key 取用。下游任務只需編輯自己的 domains/*.ts，不動本檔。
 */
export const CABINET_DOMAIN_MODULES: Record<CabinetDomain, CabinetDomainModule> =
  {
    interior: interiorModule,
    military: militaryModule,
    diplomacy: diplomacyModule,
  };

export function getDomainModule(domain: CabinetDomain): CabinetDomainModule {
  return CABINET_DOMAIN_MODULES[domain];
}

/** 該領域可授權代理項目的 key 集合（驗證 enabled_actions 用）。 */
export function domainActionKeySet(domain: CabinetDomain): Set<string> {
  return new Set(getDomainModule(domain).actionKeys.map((a) => a.key));
}

/** 過濾出屬於該領域已知 actionKeys 的授權清單（忽略未知 key）。 */
export function filterKnownActionKeys(
  domain: CabinetDomain,
  keys: readonly string[],
): string[] {
  const known = domainActionKeySet(domain);
  return keys.filter((k) => known.has(k));
}
