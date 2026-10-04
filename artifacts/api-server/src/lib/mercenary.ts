/**
 * 僱傭兵系統規則核心(DB-free 純函式,全部可單元測試)。
 *
 * 設計目標:讓小國有能力靠僱傭兵抵擋大國猛攻幾次,但大國自己也不會被僱傭兵平白壓制。
 *  - 戰力 = 公司係數 × 基準兵力 × 「弱國補償」。客戶國力越小,補償越高(有上限)。
 *  - 租金 = 僱傭兵「等效常備軍維護費」的一小部分,並隨國力與時代縮放,小國付得起。
 *  - 無傷亡:戰役結算時僱傭兵不扣兵;士氣仍照一般規則變化,所以會被打弱,但不會被殲滅。
 *  - 一次只能簽一間;有合約不能重新建軍;NPC 國家不開放。
 */

export type MercenaryCompanyId =
  | "grey_wolves"
  | "iron_shield"
  | "red_hawk"
  | "obsidian"
  | "white_raven";

export interface MercenaryCompany {
  id: MercenaryCompanyId;
  name: string;
  blurb: string;
  /** 戰力係數(相對值),決定兵力規模。 */
  power: number;
  /** 攻擊傾向係數(1 = 均衡)。防守型 < 1、進攻型 > 1。 */
  offenseBias: number;
  /** 防禦傾向係數(1 = 均衡)。 */
  defenseBias: number;
  /** 租金係數(相對值)。 */
  rent: number;
  /** 被派去戰役時每回合加收的出動費係數。 */
  deploy: number;
}

export const MERCENARY_COMPANIES: readonly MercenaryCompany[] = [
  { id: "grey_wolves", name: "灰狼傭兵團", blurb: "便宜的民兵,量大質低", power: 0.6, offenseBias: 0.9, defenseBias: 0.9, rent: 1.0, deploy: 0.5 },
  { id: "iron_shield", name: "鐵盾守衛", blurb: "專長防守,攻擊偏弱", power: 0.9, offenseBias: 0.6, defenseBias: 1.5, rent: 1.6, deploy: 0.8 },
  { id: "red_hawk", name: "赤鷹突擊隊", blurb: "專長進攻,防禦偏弱", power: 1.0, offenseBias: 1.5, defenseBias: 0.6, rent: 2.0, deploy: 1.5 },
  { id: "obsidian", name: "黑曜石戰團", blurb: "均衡的正規傭兵", power: 1.4, offenseBias: 1.1, defenseBias: 1.1, rent: 3.2, deploy: 1.8 },
  { id: "white_raven", name: "白鴉特勤處", blurb: "精銳,昂貴但最強", power: 2.0, offenseBias: 1.2, defenseBias: 1.2, rent: 5.0, deploy: 3.0 },
] as const;

export function getMercenaryCompany(id: string): MercenaryCompany | null {
  return MERCENARY_COMPANIES.find((c) => c.id === id) ?? null;
}

/* ───────────── 平衡參數(集中在此,方便調整) ───────────── */

/** 基準僱傭兵兵力佔「標準國人口」的比例(千分之一)。 */
export const BASE_TROOP_PER_STD_POP = 0.006;
/** 弱國補償:補償 = r^-SMALL_BOOST_EXP,r 為國力比(<1 為小國),並夾在 [1, MAX_SMALL_BOOST]。 */
export const SMALL_BOOST_EXP = 0.6;
export const MAX_SMALL_BOOST = 10;
/** 大國(r>1)不額外加成,也不遞減:僱傭兵是「補足弱點」,不是大國的加速器。 */
export const LARGE_NATION_BOOST = 1;
/** 租金佔「等效常備軍維護費」的比例(遠低於養兵)。 */
export const RENT_FRACTION_OF_UPKEEP = 0.18;
/** 僱傭兵單兵的等效維護費基準(與全服平均常備軍單位維護費相乘)。 */
export const RENT_MIN = 1;
/** 租金對國力的敏感度:小國再打折,但不低於此下限倍率。 */
export const RENT_SMALL_NATION_FLOOR = 0.35;
/** 出動費(被派去戰役時每回合加收)佔租金的基準比例,再乘公司 deploy 係數。 */
export const DEPLOY_FRACTION_OF_RENT = 0.5;

/* ───────────── 弱國補償 ───────────── */

/** 國力比 r → 弱國補償倍率。r<=0 視為最弱(取上限)。 */
export function smallNationBoost(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return MAX_SMALL_BOOST;
  if (r >= 1) return LARGE_NATION_BOOST;
  return Math.min(MAX_SMALL_BOOST, Math.max(1, Math.pow(r, -SMALL_BOOST_EXP)));
}

/* ───────────── 戰力 ───────────── */

export interface MercenaryForceInput {
  company: MercenaryCompany;
  /** 客戶國力比(人口 ÷ 該時代標準國人口)。 */
  powerRatio: number;
  /** 該時代標準國人口(用來決定基準兵力的絕對規模)。 */
  standardPopulation: number;
  /** 全服「步兵類」平均單位屬性(隨時代與科技自然成長)。 */
  avgHp: number;
  avgAttack: number;
  avgDefense: number;
}

export interface MercenaryForce {
  troops: number;
  attack: number;
  defense: number;
  hp: number;
  boost: number;
}

/**
 * 算出僱傭兵的虛擬單位。單兵屬性 = 全服平均 × 公司傾向;兵力 = 基準 × 公司戰力 × 弱國補償。
 * 至少 1 名兵,避免小數為 0。
 */
export function computeMercenaryForce(input: MercenaryForceInput): MercenaryForce {
  const { company, powerRatio, standardPopulation, avgHp, avgAttack, avgDefense } = input;
  const boost = smallNationBoost(powerRatio);
  const base = Math.max(0, standardPopulation) * BASE_TROOP_PER_STD_POP;
  const troops = Math.max(1, Math.round(base * company.power * boost));
  return {
    troops,
    attack: Math.max(1, Math.round(Math.max(0, avgAttack) * company.offenseBias)),
    defense: Math.max(1, Math.round(Math.max(0, avgDefense) * company.defenseBias)),
    hp: Math.max(1, Math.round(Math.max(0, avgHp))),
    boost,
  };
}

/* ───────────── 租金 ───────────── */

export interface MercenaryRentInput {
  company: MercenaryCompany;
  /** 僱傭兵實際兵力(來自 computeMercenaryForce)。 */
  troops: number;
  /** 全服平均單位維護費(已含時代/科技縮放)。 */
  avgUpkeepPerUnit: number;
  /** 客戶國力比。 */
  powerRatio: number;
}

/** 國力越小,租金再打折;下限 RENT_SMALL_NATION_FLOOR,大國不打折。 */
export function rentNationFactor(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return RENT_SMALL_NATION_FLOOR;
  if (r >= 1) return 1;
  return Math.max(RENT_SMALL_NATION_FLOOR, Math.pow(r, 0.4));
}

/** 「同規模常備軍」每回合維護費(用來當租金的比較基準)。 */
export function standingArmyUpkeep(troops: number, avgUpkeepPerUnit: number): number {
  return Math.max(0, troops) * Math.max(0, avgUpkeepPerUnit);
}

/** 每回合租金。永遠低於同規模常備軍維護費。 */
export function computeMercenaryRent(input: MercenaryRentInput): number {
  const { company, troops, avgUpkeepPerUnit, powerRatio } = input;
  const standing = standingArmyUpkeep(troops, avgUpkeepPerUnit);
  // 公司租金係數以 obsidian(3.2)附近為中位,換算成佔維護費的比例。
  const fraction = RENT_FRACTION_OF_UPKEEP * (company.rent / 3.2);
  const raw = standing * Math.min(fraction, 0.6) * rentNationFactor(powerRatio);
  const rent = Math.max(RENT_MIN, Math.round(raw));
  // 保險:絕不高於同規模常備軍維護費的 60%。
  return standing > 0 ? Math.min(rent, Math.max(RENT_MIN, Math.floor(standing * 0.6))) : rent;
}

/** 被派去戰役時每回合加收的出動費。 */
export function computeDeployFee(rent: number, company: MercenaryCompany): number {
  return Math.max(0, Math.round(rent * DEPLOY_FRACTION_OF_RENT * company.deploy));
}

/* ───────────── 規則判定 ───────────── */

export interface DisarmCheckInput {
  hasActiveCampaign: boolean;
  alreadyDisarmed: boolean;
}

export type DisarmCheck = { ok: true } | { ok: false; reason: string };

/** 可否解除武裝:有進行中戰役不可。 */
export function canDisarm(input: DisarmCheckInput): DisarmCheck {
  if (input.hasActiveCampaign) return { ok: false, reason: "有進行中的戰役,無法解除武裝" };
  if (input.alreadyDisarmed) return { ok: false, reason: "已經解除武裝" };
  return { ok: true };
}

export interface RecruitGateInput {
  hasActiveContract: boolean;
}

/** 可否招募/訓練/下佇列:有合約就擋,必須先解約。 */
export function canRecruit(input: RecruitGateInput): DisarmCheck {
  if (input.hasActiveContract) return { ok: false, reason: "簽有僱傭兵合約期間不能建軍,請先解約" };
  return { ok: true };
}

export interface SignCheckInput {
  isNpc: boolean;
  disarmed: boolean;
  activeContractCompanyId: string | null;
  companyId: string;
}

/** 可否簽約:僅玩家、需已解除武裝、同時只能一間、公司需存在。 */
export function canSignContract(input: SignCheckInput): DisarmCheck {
  if (input.isNpc) return { ok: false, reason: "NPC 國家不開放僱傭兵" };
  if (!getMercenaryCompany(input.companyId)) return { ok: false, reason: "找不到這間軍事公司" };
  if (!input.disarmed) return { ok: false, reason: "需先解除武裝才能簽訂軍事合約" };
  if (input.activeContractCompanyId) return { ok: false, reason: "已有生效中的合約,請先解約再換家" };
  return { ok: true };
}
