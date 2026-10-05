/**
 * 國內隨機事件(2026-10-05 定案):純邏輯,不碰資料庫,可完全單元測試。
 *
 * 規則:
 *  - 每 EVENT_EVERY_TURNS 個回合,對每個玩家國擲 EVENT_CHANCE 機率;同一國同時只有一個未處理事件。
 *  - 事件的選項「效果數字」永遠是固定的;AI 只負責改寫標題/敘述/選項文字(防止被鑽漏洞)。
 *  - 玩家 EVENT_DEADLINE_TURNS 個回合沒回應,自動套用預設選項(通常是「拖延」)。
 *  - 君主制(獨裁層級)也會發生:社會黨多數事件會臨時插入一個福利派席次。
 */

export const EVENT_EVERY_TURNS = 2;
export const EVENT_CHANCE = 0.3;
export const EVENT_DEADLINE_TURNS = 3;
/** 同一種事件再次發生,至少要隔幾個回合(2026-10-06 使用者要求:不想看到事件重複)。 */
export const EVENT_REPEAT_COOLDOWN_TURNS = 32;

/** 鎮壓後低穩定度引發內戰的門檻與機率 */
export const CIVIL_WAR_STABILITY_BELOW = 25;
export const CIVIL_WAR_CHANCE = 0.35;

export type DomesticEventKind =
  | "recall_wave"
  | "socialist_majority"
  | "military_petition"
  | "economic_crisis"
  | "religious_revival"
  | "constitutional_crisis";

/** 只能由憲法漏洞觸發的事件種類:不進隨機抽選、不進管理員投放目錄。 */
export const CONSTITUTION_ONLY_KINDS: readonly DomesticEventKind[] = ["constitutional_crisis"];

export type ChoiceStyle = "comply" | "crackdown" | "delay";

/** 一個選項對國家造成的固定效果 */
export interface ChoiceEffects {
  stability?: number;
  money?: number;
  politicalSupport?: number;
  militarySatisfaction?: number;
  parliamentSatisfaction?: number;
  /** 鎮壓類選項:穩定度低於門檻時有機率爆發內戰 */
  civilWarRisk?: boolean;
  /** 社會黨多數事件專用:順應 = 議會被福利派掌握;鎮壓 = 福利派被逐出議會 */
  parliamentShift?: "socialists_in" | "socialists_out";
}

export interface EventChoiceDef {
  id: string;
  style: ChoiceStyle;
  /** 模板文字(沒有 AI 或 AI 失敗時使用) */
  label: string;
  hint: string;
  effects: ChoiceEffects;
}

export interface DomesticEventDef {
  kind: DomesticEventKind;
  title: string;
  /** 模板敘述 */
  body: string;
  choices: readonly EventChoiceDef[];
  /** 逾時自動套用的選項 id */
  defaultChoiceId: string;
  /** 抽到的相對權重 */
  weight: number;
}

export const DOMESTIC_EVENTS: readonly DomesticEventDef[] = [
  {
    kind: "recall_wave",
    title: "國內爆發罷免潮",
    body: "街頭的連署與集會一波接一波,民眾要求罷免現任官員,議會內也有人附和。",
    weight: 10,
    defaultChoiceId: "delay",
    choices: [
      { id: "comply", style: "comply", label: "接受罷免,改組內閣", hint: "穩定與議會回升,軍方不滿", effects: { stability: 8, parliamentSatisfaction: 10, militarySatisfaction: -5 } },
      { id: "crackdown", style: "crackdown", label: "宣布戒嚴,取締集會", hint: "軍方支持,但穩定大降且有內戰風險", effects: { stability: -20, militarySatisfaction: 12, civilWarRisk: true } },
      { id: "delay", style: "delay", label: "拖延,等風頭過去", hint: "穩定與議會都受損", effects: { stability: -6, parliamentSatisfaction: -8 } },
    ],
  },
  {
    kind: "socialist_majority",
    title: "社會黨人取得議會多數",
    body: "選舉與補選之後,社會黨人成為議會最大勢力,議會要求政府推動他們的政策。",
    weight: 10,
    defaultChoiceId: "delay",
    choices: [
      { id: "comply", style: "comply", label: "順應議會,推動社會政策", hint: "議會大幅回升,但國庫吃緊、軍方不安", effects: { parliamentSatisfaction: 15, money: -1500, militarySatisfaction: -8, parliamentShift: "socialists_in" } },
      { id: "crackdown", style: "crackdown", label: "宣布戒嚴,將社會黨人逐出議會", hint: "軍方支持,但穩定暴跌且有內戰風險", effects: { stability: -25, militarySatisfaction: 15, parliamentSatisfaction: -15, civilWarRisk: true, parliamentShift: "socialists_out" } },
      { id: "delay", style: "delay", label: "折衷讓步,只採納部分主張", hint: "議會略升,花一點錢", effects: { parliamentSatisfaction: 4, money: -600 } },
    ],
  },
  {
    kind: "military_petition",
    title: "軍方聯名請願",
    body: "將領們聯名上書,要求增加軍費與裝備預算,否則軍心難以維繫。",
    weight: 8,
    defaultChoiceId: "delay",
    choices: [
      { id: "comply", style: "comply", label: "批准擴編與軍費", hint: "軍方大悅,國庫失血", effects: { militarySatisfaction: 15, money: -2000 } },
      { id: "crackdown", style: "crackdown", label: "駁回並整肅請願者", hint: "軍方大怒,但政局暫穩", effects: { militarySatisfaction: -15, stability: 3 } },
      { id: "delay", style: "delay", label: "設宴安撫,不給預算", hint: "軍方小升,政治支持略降", effects: { militarySatisfaction: 4, politicalSupport: -4 } },
    ],
  },
  {
    kind: "economic_crisis",
    title: "經濟危機來襲",
    body: "物價飛漲、工廠停工,銀行門口排起長隊,民怨沸騰。",
    weight: 8,
    defaultChoiceId: "delay",
    choices: [
      { id: "comply", style: "comply", label: "動用國庫緊急紓困", hint: "穩定回升,國庫大失血", effects: { money: -2500, stability: 8 } },
      { id: "crackdown", style: "crackdown", label: "推行緊縮,強壓物價", hint: "國庫回血,但穩定與議會下滑", effects: { money: 1500, stability: -8, parliamentSatisfaction: -6 } },
      { id: "delay", style: "delay", label: "靜觀其變", hint: "穩定下滑", effects: { stability: -10 } },
    ],
  },
  {
    kind: "religious_revival",
    title: "宗教復興運動",
    body: "各地教會集會日益頻繁,信眾要求政府重新確立信仰在公共生活中的地位。",
    weight: 6,
    defaultChoiceId: "delay",
    choices: [
      { id: "comply", style: "comply", label: "扶持教會,給予特權", hint: "議會與支持度上升,軍方略有疑慮", effects: { parliamentSatisfaction: 6, politicalSupport: 6, militarySatisfaction: -3 } },
      { id: "crackdown", style: "crackdown", label: "強行世俗化,取締集會", hint: "軍方支持,但穩定與議會下滑", effects: { stability: -10, militarySatisfaction: 6, parliamentSatisfaction: -6 } },
      { id: "delay", style: "delay", label: "保持中立", hint: "議會略降", effects: { parliamentSatisfaction: -2 } },
    ],
  },
];

/**
 * 憲法危機(2026-10-06):由通過後的憲法漏洞觸發。標題與敘述在建立事件時換成該漏洞的文字,
 * 這裡的三個選項與效果數字永遠固定(AI 只負責描述漏洞,碰不到數字)。
 * 刻意不放進 DOMESTIC_EVENTS:不會被隨機抽到,管理員目錄也看不到。
 */
export const CONSTITUTIONAL_CRISIS_DEF: DomesticEventDef = {
  kind: "constitutional_crisis",
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

/** 依權重抽一個事件種類 */
export function pickEventKind(rand: () => number, exclude: readonly string[] = []): DomesticEventKind {
  const pool = DOMESTIC_EVENTS.filter((e) => !exclude.includes(e.kind));
  const list = pool.length > 0 ? pool : DOMESTIC_EVENTS;
  const total = list.reduce((s, e) => s + e.weight, 0);
  let r = rand() * total;
  for (const e of list) {
    r -= e.weight;
    if (r < 0) return e.kind;
  }
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

/** 驗證目錄本身(供測試與啟動自檢):每個事件三個風格各一、預設選項存在、id 不重複 */
export function validateEventCatalog(defs: readonly DomesticEventDef[] = DOMESTIC_EVENTS): string[] {
  const problems: string[] = [];
  const kinds = new Set<string>();
  for (const d of defs) {
    if (kinds.has(d.kind)) problems.push(`重複事件 ${d.kind}`);
    kinds.add(d.kind);
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
    }
  }
  return problems;
}
