import type { FocusDef } from "./types";
import { COMMUNIST_REVOLUTION_ID } from "./regimeFocuses";

/**
 * 共產革命之後的三條路線(2026-10-05 使用者指定)。
 *
 * 設計原則:
 *  - 三個起點國策(馬列 / 毛澤東思想 / 鐵托)互斥,選一條就永遠鎖死另外兩條;
 *  - 必須革命「打贏」(政體已變成委員會制)才看得到、才點得了,內戰進行中不開放;
 *  - 每條路線各自長出三個後續國策,互不通用,這是路線「高度影響後續國策」的來源;
 *  - 常駐加成只用已接線的 pointsPerTurn / focusSpeed(見 effects.ts),不寫會落空的數字。
 */

/** 路線起點 id(供視圖與測試引用) */
export const PATH_MARXIST_LENINIST_ID = "path.marxist_leninist";
export const PATH_MAOIST_ID = "path.maoist";
export const PATH_TITOIST_ID = "path.titoist";
export const COMMUNIST_PATH_ROOT_IDS: readonly string[] = [PATH_MARXIST_LENINIST_ID, PATH_MAOIST_ID, PATH_TITOIST_ID];

/** 路線互斥群組 */
export const COMMUNIST_PATH_GROUP = "communist_path";

/** 革命打贏後的政體(委員會制);路線國策只在這個政體開放 */
const AFTER_REVOLUTION_GOVERNMENTS = ["council_system"];

/**
 * 後續國策共用骨架:掛在各自路線起點之下,政體限委員會制。
 * 後續國策之間再形成第二層(例如 工業化 需要 五年計劃)。
 */
function follow(
  def: Omit<FocusDef, "domain" | "track" | "slot" | "governments" | "milestone"> & { slot?: FocusDef["slot"] },
): FocusDef {
  return {
    domain: "interior",
    track: "red",
    slot: def.slot ?? "side",
    governments: AFTER_REVOLUTION_GOVERNMENTS,
    ...def,
  };
}

export function buildCommunistPathFocuses(): FocusDef[] {
  return [
    // ───────────────────── 馬列主義:中央計劃、重工與軍工 ─────────────────────
    {
      id: PATH_MARXIST_LENINIST_ID,
      domain: "regime",
      track: "red",
      slot: "main",
      title: "馬列主義",
      description:
        "以先鋒黨領導、國家計劃經濟與重工業優先立國。軍方與國庫立刻受益,政治點數收入永久提高;代價是議會被黨完全收編、不再有獨立的聲音。一旦選定就不能再走毛澤東思想或鐵托主義。",
      cost: 20,
      turns: 8,
      requires: [COMMUNIST_REVOLUTION_ID],
      exclusiveGroup: COMMUNIST_PATH_GROUP,
      governments: AFTER_REVOLUTION_GOVERNMENTS,
      milestone: true,
      effects: [
        { kind: "unlock", capability: "path.marxist_leninist" },
        { kind: "modifier", stat: "pointsPerTurn", value: 1 },
        { kind: "militarySatisfaction", value: 15 },
        { kind: "grant", stat: "money", value: 1500 },
        { kind: "parliamentSatisfaction", value: -10 },
      ],
    },
    follow({
      id: "path.ml.five_year_plan",
      title: "五年計劃",
      description: "由國家計劃委員會統籌全國生產與分配,前期要抽調大量資金,換來穩定的長期國庫與更快的國策推進。",
      cost: 12, turns: 6,
      requires: [PATH_MARXIST_LENINIST_ID],
      effects: [
        { kind: "grant", stat: "money", value: -1500 },
        { kind: "grant", stat: "stability", value: 6 },
        { kind: "modifier", stat: "focusSpeed", value: 10 },
      ],
    }),
    follow({
      id: "path.ml.one_party_state",
      title: "一黨專政",
      description: "黨國一體,政治局拍板。穩定度與政治支持大幅提升,但軍方對黨的直接控制心存芥蒂。",
      cost: 14, turns: 6,
      requires: [PATH_MARXIST_LENINIST_ID],
      effects: [
        { kind: "grant", stat: "stability", value: 10 },
        { kind: "grant", stat: "politicalSupport", value: 8 },
        { kind: "militarySatisfaction", value: -6 },
      ],
    }),
    follow({
      id: "path.ml.heavy_industry",
      title: "重工業優先",
      description: "一切資源向鋼鐵、機械與軍工傾斜。軍方大為滿意、科技突飛猛進,但消費品匱乏使民怨上升。",
      cost: 16, turns: 8,
      requires: ["path.ml.five_year_plan"],
      effects: [
        { kind: "grant", stat: "techPoints", value: 12 },
        { kind: "militarySatisfaction", value: 10 },
        { kind: "grant", stat: "politicalSupport", value: -8 },
      ],
    }),

    // ───────────────────── 毛澤東思想:農民群眾、持久動員 ─────────────────────
    {
      id: PATH_MAOIST_ID,
      domain: "regime",
      track: "red",
      slot: "main",
      title: "毛澤東思想",
      description:
        "以農民為革命主力,相信人民戰爭與群眾路線。國策推進明顯加快、群眾基礎穩固,紅色傾向進一步強化;代價是革命熱潮帶來的動盪與對專業階層的猜疑。一旦選定就不能再走馬列主義或鐵托主義。",
      cost: 20,
      turns: 8,
      requires: [COMMUNIST_REVOLUTION_ID],
      exclusiveGroup: COMMUNIST_PATH_GROUP,
      governments: AFTER_REVOLUTION_GOVERNMENTS,
      milestone: true,
      effects: [
        { kind: "unlock", capability: "path.maoist" },
        { kind: "modifier", stat: "focusSpeed", value: 15 },
        { kind: "grant", stat: "politicalSupport", value: 12 },
        { kind: "lean", side: "red", value: 10 },
        { kind: "grant", stat: "stability", value: -10 },
      ],
    },
    follow({
      id: "path.mao.peoples_war",
      title: "人民戰爭",
      description: "把全民組織成民兵與後勤網,打持久戰、游擊戰。軍方因群眾分走部分地位而不滿,但國防動員能力大增。",
      cost: 12, turns: 6,
      requires: [PATH_MAOIST_ID],
      effects: [
        { kind: "grant", stat: "stability", value: 5 },
        { kind: "grant", stat: "politicalSupport", value: 6 },
        { kind: "militarySatisfaction", value: -8 },
      ],
    }),
    follow({
      id: "path.mao.mass_line",
      title: "群眾路線",
      description: "幹部下放、從群眾中來到群眾中去。議會與民意接地氣,但官僚體系效率受損,要花錢安撫。",
      cost: 14, turns: 6,
      requires: [PATH_MAOIST_ID],
      effects: [
        { kind: "parliamentSatisfaction", value: 12 },
        { kind: "grant", stat: "politicalSupport", value: 6 },
        { kind: "grant", stat: "money", value: -1200 },
      ],
    }),
    follow({
      id: "path.mao.land_reform",
      title: "土地改革",
      description: "打倒地主、分田到戶,農村一夜翻身。穩定與支持度飆升,但大規模重分配衝擊既有生產,庫房短期吃緊。",
      cost: 16, turns: 8,
      requires: ["path.mao.mass_line"],
      effects: [
        { kind: "grant", stat: "stability", value: 14 },
        { kind: "grant", stat: "politicalSupport", value: 10 },
        { kind: "grant", stat: "money", value: -2200 },
      ],
    }),

    // ───────────────────── 鐵托主義:自主管理、不結盟 ─────────────────────
    {
      id: PATH_TITOIST_ID,
      domain: "regime",
      track: "red",
      slot: "main",
      title: "鐵托主義",
      description:
        "走獨立自主的社會主義:工人自治、不依附任何集團。議會與國內穩定獲得改善,政治點數收入永久提高;代價是不願被軍事化,軍方認為自己被邊緣化。一旦選定就不能再走馬列主義或毛澤東思想。",
      cost: 20,
      turns: 8,
      requires: [COMMUNIST_REVOLUTION_ID],
      exclusiveGroup: COMMUNIST_PATH_GROUP,
      governments: AFTER_REVOLUTION_GOVERNMENTS,
      milestone: true,
      effects: [
        { kind: "unlock", capability: "path.titoist" },
        { kind: "modifier", stat: "pointsPerTurn", value: 1 },
        { kind: "grant", stat: "stability", value: 10 },
        { kind: "parliamentSatisfaction", value: 10 },
        { kind: "militarySatisfaction", value: -10 },
      ],
    },
    follow({
      id: "path.tito.self_management",
      title: "工人自治",
      description: "工廠交給工人委員會自己管。生產熱情與議會支持上升,但國庫要先付出改制的成本。",
      cost: 12, turns: 6,
      requires: [PATH_TITOIST_ID],
      effects: [
        { kind: "parliamentSatisfaction", value: 8 },
        { kind: "grant", stat: "politicalSupport", value: 8 },
        { kind: "grant", stat: "money", value: -1200 },
      ],
    }),
    follow({
      id: "path.tito.non_aligned",
      title: "不結盟",
      description: "不加入任何陣營,在大國之間左右逢源,換來穩定的外部環境。代價是放棄軍事集團的庇護,軍方不安。",
      cost: 14, turns: 6,
      requires: [PATH_TITOIST_ID],
      effects: [
        { kind: "grant", stat: "stability", value: 8 },
        { kind: "grant", stat: "money", value: 1000 },
        { kind: "militarySatisfaction", value: -6 },
      ],
    }),
    follow({
      id: "path.tito.market_socialism",
      title: "市場社會主義",
      description: "在公有制框架下引入市場競爭。國庫與科技收益可觀,但黨內保守派認為偏離了正統,議會出現分歧。",
      cost: 16, turns: 8,
      requires: ["path.tito.self_management"],
      effects: [
        { kind: "grant", stat: "money", value: 2500 },
        { kind: "grant", stat: "techPoints", value: 8 },
        { kind: "parliamentSatisfaction", value: -8 },
      ],
    }),
  ];
}
