/**
 * 國內隨機事件(2026-10-05 定案):純邏輯,不碰資料庫,可完全單元測試。
 *
 * 規則:
 *  - 每 EVENT_EVERY_TURNS 個回合,對每個玩家國擲 EVENT_CHANCE 機率;同一國同時只有一個未處理事件。
 *  - 事件的選項「效果數字」永遠是固定的;AI 只負責改寫標題/敘述/選項文字(防止被鑽漏洞)。
 *  - 玩家 EVENT_DEADLINE_TURNS 個回合沒回應,自動套用預設選項(通常是「拖延」)。
 *  - 君主制(獨裁層級)也會發生:社會黨多數事件會臨時插入一個福利派席次。
 */

import { EVENT_CATEGORY_META, isEventCategory } from "./categories";
import { ALL_CATALOG_EVENTS } from "./catalog";

export const EVENT_EVERY_TURNS = 2;
export const EVENT_CHANCE = 0.3;
export const EVENT_DEADLINE_TURNS = 3;
/** 同一種事件再次發生,至少要隔幾個回合(2026-10-06 使用者要求:不想看到事件重複)。 */
export const EVENT_REPEAT_COOLDOWN_TURNS = 32;

/** 鎮壓後低穩定度引發內戰的門檻與機率 */
export const CIVIL_WAR_STABILITY_BELOW = 25;
export const CIVIL_WAR_CHANCE = 0.35;

/**
 * 事件種類 id(資料庫存的就是這個字串)。100 個事件不再用寫死的聯集型別,
 * 改由目錄驗證保證 id 唯一、格式正確(見 validateEventCatalog)。
 */
export type DomesticEventKind = string;

/** 只能由憲法漏洞觸發的事件種類:不進隨機抽選、不進管理員投放目錄。 */
export const CONSTITUTION_ONLY_KINDS: readonly DomesticEventKind[] = ["constitutional_crisis"];

export type { ChoiceStyle, ChoiceEffects, EventChoiceDef, DomesticEventDef } from "./types";
import type { ChoiceEffects, DomesticEventDef } from "./types";

/** 全部隨機事件(100 個):依分類放在 catalog/ 資料夾,一個分類一個檔案。 */
export const DOMESTIC_EVENTS: readonly DomesticEventDef[] = ALL_CATALOG_EVENTS;

/**
 * 憲法危機(2026-10-06):由通過後的憲法漏洞觸發。標題與敘述在建立事件時換成該漏洞的文字,
 * 這裡的三個選項與效果數字永遠固定(AI 只負責描述漏洞,碰不到數字)。
 * 刻意不放進 DOMESTIC_EVENTS:不會被隨機抽到,管理員目錄也看不到。
 */
export const CONSTITUTIONAL_CRISIS_DEF: DomesticEventDef = {
  kind: "constitutional_crisis",
  category: "politics",
  title: "憲法危機",
  body: "憲法條文中的一處漏洞被人拿來大做文章,各方對條文的解釋針鋒相對。",
  weight: 1,
  defaultChoiceId: "delay",
  choices: [
    { id: "comply", style: "comply", label: "召集議會修補解釋,公開讓步", hint: "議會與穩定回升,國庫花一點錢", effects: { parliamentSatisfaction: 8, stability: 4, money: -800 } },
    { id: "crackdown", style: "crackdown", label: "以行政命令強行解釋條文", hint: "軍方支持,但議會與穩定大降且有內戰風險", effects: { militarySatisfaction: 8, parliamentSatisfaction: -12, stability: -14, civilWarRisk: true } },
    { id: "delay", style: "delay", label: "擱置爭議,等風頭過去", hint: "議會與穩定都受損", effects: { parliamentSatisfaction: -6, stability: -6 } },
  ],
};

export function getEventDef(kind: string): DomesticEventDef | undefined {
  if (kind === CONSTITUTIONAL_CRISIS_DEF.kind) return CONSTITUTIONAL_CRISIS_DEF;
  return DOMESTIC_EVENTS.find((e) => e.kind === kind);
}

/** 這個回合是不是「擲骰回合」?(每 EVENT_EVERY_TURNS 回合一次;tick 從 0 起算) */
export function isRollTurn(tick: number): boolean {
  return Number.isInteger(tick) && tick > 0 && tick % EVENT_EVERY_TURNS === 0;
}

/** 擲骰:rand 是 [0,1) 的亂數來源(測試可注入) */
export function rollsEvent(rand: () => number): boolean {
  return rand() < EVENT_CHANCE;
}

/**
 * 兩段式抽選(2026-10-06):先依「分類權重」抽類別(只考慮還有可抽事件的類別),
 * 再在類別內依事件權重抽事件。這樣某一類事件寫得多,也不會壓過其他類。
 * exclude 是要排除的事件(冷卻中);全被排除時退回全池(與舊行為一致,冷卻另由 pickEventKindWithCooldown 處理)。
 */
export function pickEventKind(rand: () => number, exclude: readonly string[] = []): DomesticEventKind {
  let pool = DOMESTIC_EVENTS.filter((e) => !exclude.includes(e.kind));
  if (pool.length === 0) pool = [...DOMESTIC_EVENTS];
  const cats = EVENT_CATEGORY_META.filter((m) => pool.some((e) => e.category === m.id));
  const totalCat = cats.reduce((a, m) => a + m.weight, 0);
  let r = rand() * totalCat;
  let chosen = cats[cats.length - 1]!;
  for (const m of cats) { r -= m.weight; if (r < 0) { chosen = m; break; } }
  const list = pool.filter((e) => e.category === chosen.id);
  const total = list.reduce((a, e) => a + e.weight, 0);
  let r2 = rand() * total;
  for (const e of list) { r2 -= e.weight; if (r2 < 0) return e.kind; }
  return list[list.length - 1]!.kind;
}

/**
 * 目前仍在冷卻的事件種類:該種事件最近一次發生的 tick 與現在相差不足 EVENT_REPEAT_COOLDOWN_TURNS。
 * history 只需要 (kind, createdTick);同種有多筆時取最近的。
 */
export function eventKindsOnCooldown(
  history: readonly { kind: string; createdTick: number }[],
  currentTick: number,
  cooldown: number = EVENT_REPEAT_COOLDOWN_TURNS,
): string[] {
  const latest = new Map<string, number>();
  for (const h of history) {
    const prev = latest.get(h.kind);
    if (prev === undefined || h.createdTick > prev) latest.set(h.kind, h.createdTick);
  }
  const out: string[] = [];
  for (const [kind, t] of latest) if (currentTick - t < cooldown) out.push(kind);
  return out;
}

/**
 * 抽事件並遵守重複冷卻。與 pickEventKind 不同:所有種類都在冷卻時回傳 null(這回合不發事件),
 * 不會退回「全池重抽」——否則冷卻在事件種類少時形同虛設。
 */
export function pickEventKindWithCooldown(
  rand: () => number,
  history: readonly { kind: string; createdTick: number }[],
  currentTick: number,
  cooldown: number = EVENT_REPEAT_COOLDOWN_TURNS,
): DomesticEventKind | null {
  const blocked = eventKindsOnCooldown(history, currentTick, cooldown);
  if (DOMESTIC_EVENTS.every((e) => blocked.includes(e.kind))) return null;
  return pickEventKind(rand, blocked);
}

/** 鎮壓是否引爆內戰:只有帶 civilWarRisk 的選項,且「套用後」穩定度低於門檻才擲骰 */
export function triggersCivilWar(effects: ChoiceEffects, stabilityAfter: number, rand: () => number): boolean {
  if (!effects.civilWarRisk) return false;
  if (!(stabilityAfter < CIVIL_WAR_STABILITY_BELOW)) return false;
  return rand() < CIVIL_WAR_CHANCE;
}

/** 事件是否逾時(以回合數計) */
export function isExpired(currentTick: number, dueTick: number): boolean {
  return currentTick >= dueTick;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * 把效果套到國家數值上(純函式):穩定/政治支持/軍方 夾在 0-100,金錢不設下限但不低於 0。
 * 議會滿意度的夾限由議會表自己處理,這裡只回傳增量。
 */
export function applyEffects(
  nation: { stability: number; money: number; politicalSupport: number; satisfactionMilitary: number },
  e: ChoiceEffects,
): { stability: number; money: number; politicalSupport: number; satisfactionMilitary: number; parliamentDelta: number } {
  return {
    stability: clamp(nation.stability + (e.stability ?? 0), 0, 100),
    money: Math.max(0, nation.money + (e.money ?? 0)),
    politicalSupport: clamp(nation.politicalSupport + (e.politicalSupport ?? 0), 0, 100),
    satisfactionMilitary: clamp(nation.satisfactionMilitary + (e.militarySatisfaction ?? 0), 0, 100),
    parliamentDelta: e.parliamentSatisfaction ?? 0,
  };
}

/** 事件選項的「強度」:各項變動的絕對值加總(金錢每 250 算 1 點)。用來檢查數值平衡。 */
export function choiceIntensity(e: ChoiceEffects): number {
  return Math.abs(e.stability ?? 0) + Math.abs((e.money ?? 0) / 250) + Math.abs(e.politicalSupport ?? 0)
    + Math.abs(e.militarySatisfaction ?? 0) + Math.abs(e.parliamentSatisfaction ?? 0);
}

/** 各風格的強度允許區間(以原本 5 個事件的量級為基準,2026-10-06 定案) */
export const INTENSITY_RANGE = {
  comply: { min: 10, max: 32 },
  crackdown: { min: 14, max: 40 },
  delay: { min: 2, max: 16 },
} as const;
/** 內建的特殊事件(帶議會席次改動)可超出區間 */
const INTENSITY_EXEMPT = new Set(["socialist_majority"]);

const KIND_RE = /^[a-z][a-z0-9_]{2,47}$/;

/**
 * 驗證目錄本身(供測試與啟動自檢):id 格式與唯一、分類存在且各類數量正確、
 * 每個事件三個風格各一、預設選項存在、數值強度在區間內、鎮壓比順應更「痛」(風險與報酬對稱)。
 */
export function validateEventCatalog(defs: readonly DomesticEventDef[] = DOMESTIC_EVENTS): string[] {
  const problems: string[] = [];
  const kinds = new Set<string>();
  const titles = new Set<string>();
  const perCategory = new Map<string, number>();
  for (const d of defs) {
    if (kinds.has(d.kind)) problems.push(`重複事件 ${d.kind}`);
    kinds.add(d.kind);
    if (!KIND_RE.test(d.kind)) problems.push(`${d.kind} id 格式不合(小寫英數底線,3~48 字)`);
    if (titles.has(d.title)) problems.push(`${d.kind} 標題與別的事件重複:${d.title}`);
    titles.add(d.title);
    if (!isEventCategory(d.category)) problems.push(`${d.kind} 分類不存在:${String(d.category)}`);
    perCategory.set(d.category, (perCategory.get(d.category) ?? 0) + 1);
    if (!d.title.trim() || !d.body.trim()) problems.push(`${d.kind} 缺標題或敘述`);
    if (d.weight <= 0) problems.push(`${d.kind} 權重必須為正`);
    const ids = d.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`${d.kind} 選項 id 重複`);
    if (!ids.includes(d.defaultChoiceId)) problems.push(`${d.kind} 預設選項不存在`);
    const styles = d.choices.map((c) => c.style).sort().join(",");
    if (styles !== "comply,crackdown,delay") problems.push(`${d.kind} 必須恰好有 順應/鎮壓/拖延 各一`);
    for (const c of d.choices) {
      if (!c.label.trim() || !c.hint.trim()) problems.push(`${d.kind}/${c.id} 缺文字`);
      if (Object.keys(c.effects).length === 0) problems.push(`${d.kind}/${c.id} 沒有任何效果`);
      if (c.effects.civilWarRisk && c.style !== "crackdown") problems.push(`${d.kind}/${c.id} 只有鎮壓可帶內戰風險`);
      if (!INTENSITY_EXEMPT.has(d.kind) && c.style in INTENSITY_RANGE) {
        const r = INTENSITY_RANGE[c.style as keyof typeof INTENSITY_RANGE];
        const i = choiceIntensity(c.effects);
        if (i < r.min || i > r.max) problems.push(`${d.kind}/${c.id} 強度 ${i.toFixed(1)} 超出 ${c.style} 區間 ${r.min}~${r.max}`);
      }
    }
    const byStyle = (st: string) => d.choices.find((c) => c.style === st);
    const cr = byStyle("crackdown"), cp = byStyle("comply"), dl = byStyle("delay");
    if (!INTENSITY_EXEMPT.has(d.kind) && cr && cp && dl) {
      if (choiceIntensity(dl.effects) >= choiceIntensity(cp.effects)) problems.push(`${d.kind} 拖延的衝擊不該大於等於順應`);
    }
  }
  for (const m of EVENT_CATEGORY_META) {
    const n = perCategory.get(m.id) ?? 0;
    if (defs === DOMESTIC_EVENTS && n !== m.expectedCount) problems.push(`分類 ${m.id} 應有 ${m.expectedCount} 個事件,實際 ${n}`);
  }
  return problems;
}
