import type {
  CabinetApproval,
  CabinetDomainSettingsRow,
  CabinetMinister,
  CabinetStyle,
  PlayerNation,
} from "@workspace/db";

/**
 * Task #242 — 內閣系統共用型別（地基）。
 *
 * 三個領域各有一位大臣，並對應一個獨立的「領域模組」（domains/*.ts）。
 * 下游任務只需編輯自己領域的模組檔（新增 actionKeys、實作 runDomain／
 * executeApproved），不動本檔與其他共用檔。
 */

export const CABINET_DOMAINS = ["interior", "military", "diplomacy"] as const;
export type CabinetDomain = (typeof CABINET_DOMAINS)[number];

/** 領域 → 大臣職稱（zh-TW）。 */
export const CABINET_DOMAIN_LABELS: Record<CabinetDomain, string> = {
  interior: "內政大臣",
  military: "元帥",
  diplomacy: "外交官",
};

/** 領域 → 大臣所轄範疇的簡短說明（AI 生成人物 & 前端說明用）。 */
export const CABINET_DOMAIN_SCOPES: Record<CabinetDomain, string> = {
  interior: "內政、政策、政府決策與財政預算",
  military: "軍事建設、兵種設計、軍事科技與戰爭指揮",
  diplomacy: "外交締約、邦交往來與睦鄰交流",
};

export function isCabinetDomain(value: string): value is CabinetDomain {
  return (CABINET_DOMAINS as readonly string[]).includes(value);
}

/**
 * 已停用的內閣代理領域。停用後：回合引擎跳過該領域 runDomain、
 * 不可生成候選人／任命大臣、待批准事項不可批准（僅能否決清除）；
 * 既有大臣保留可卸任。要恢復某領域，從此集合移除即可（不必改其他檔）。
 */
export const DISABLED_CABINET_DOMAINS: ReadonlySet<CabinetDomain> = new Set([
  "diplomacy",
]);

export function isCabinetDomainDisabled(domain: CabinetDomain): boolean {
  return DISABLED_CABINET_DOMAINS.has(domain);
}

/** 代理程度：保守 / 均衡 / 積極。 */
export const AGENCY_LEVELS = [
  "conservative",
  "balanced",
  "aggressive",
] as const;
export type AgencyLevel = (typeof AGENCY_LEVELS)[number];

export const AGENCY_LEVEL_LABELS: Record<AgencyLevel, string> = {
  conservative: "保守",
  balanced: "均衡",
  aggressive: "積極",
};

export function isAgencyLevel(value: string): value is AgencyLevel {
  return (AGENCY_LEVELS as readonly string[]).includes(value);
}

/** 領域模組宣告的可代理項目（key 穩定、label 為 zh-TW 顯示）。 */
export interface DomainActionKey {
  /** 穩定識別字（存 enabled_actions／approvals.action_key）。 */
  key: string;
  /** zh-TW 顯示標籤。 */
  label: string;
  /** 一句話說明（前端勾選清單顯示）。 */
  description?: string;
}

/** 每回合大臣自動執行時傳入 domain 模組的情境。 */
export interface RunDomainContext {
  nation: PlayerNation;
  minister: CabinetMinister;
  settings: CabinetDomainSettingsRow;
  /** 已授權代理且屬於本領域 actionKeys 的 key 清單。 */
  enabledActionKeys: string[];
  /** 玩家設定的常駐方針。 */
  directive: string;
  /** 代理程度。 */
  agencyLevel: AgencyLevel;
  /** 資料時代 slug（統計用）。 */
  era: string;
}

/** 玩家批准某待批准事項後，執行時傳入 domain 模組的情境。 */
export interface ExecuteApprovedContext {
  nation: PlayerNation;
  approval: CabinetApproval;
}

/**
 * 領域模組介面。三個模組（interior/military/diplomacy）各自實作，
 * 由 registry 匯總。地基階段 runDomain／executeApproved 皆為 no-op stub。
 */
export interface CabinetDomainModule {
  domain: CabinetDomain;
  /** 本領域可授權代理的項目（前端資料驅動渲染勾選清單）。 */
  actionKeys: DomainActionKey[];
  /** 每回合結算時自動執行（stub：地基階段不做事）。 */
  runDomain(ctx: RunDomainContext): Promise<void>;
  /** 玩家批准待批准事項後執行（stub：地基階段不做事）。 */
  executeApproved(ctx: ExecuteApprovedContext): Promise<void>;
}

export type { CabinetStyle };
