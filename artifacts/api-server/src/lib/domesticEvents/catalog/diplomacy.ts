import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 外交(10):邊界摩擦、使節羞辱、間諜案、難民潮、禁運威脅、領館庇護、漁權糾紛、外媒抹黑、僑民暴動、使館遇襲 */
export const DIPLOMACY_EVENTS: readonly DomesticEventDef[] = [
  ev("diplomacy", "dip_border_friction", "邊境邊防部隊衝突",
    "鄰國「北嶺王國」巡邏隊越過爭議邊界並與我軍對峙，民間抗議聲浪高漲，軍方強烈要求採取行動。", 8,
    ["劃定緩衝區並撥款補貼", "國庫失血且軍方不滿，但穩定與議會上升", { money: -1500, militarySatisfaction: -6, stability: 6, parliamentSatisfaction: 6 }],
    ["增兵邊境展開強硬反擊", "軍方士氣大振，但國庫大失血且有內戰風險", { militarySatisfaction: 14, money: -2000, stability: -10, civilWarRisk: true }],
    ["成立聯合調查委員會", "軍方與政治支持微幅下降", { militarySatisfaction: -3, politicalSupport: -3 }]),

  ev("diplomacy", "dip_envoy_insult", "外國使節言論惹議",
    "「赤灣聯邦」大使在國宴場合公開嘲諷我國國會效率，引發輿論憤怒，反對黨要求驅逐大使。", 7,
    ["發布聯合聲明化解尷尬", "支付公關費用，議會滿意但軍方與支持度受損", { money: -1000, parliamentSatisfaction: 6, militarySatisfaction: -4, politicalSupport: -4 }],
    ["驅逐大使並限期離境", "軍方與民間挺政府，但穩定度下降且具內戰風險", { militarySatisfaction: 12, politicalSupport: 8, stability: -10, civilWarRisk: true }],
    ["私下提出外交抗議", "政治支持與議會滿意度小幅下降", { politicalSupport: -3, parliamentSatisfaction: -3 }]),

  ev("diplomacy", "dip_espionage_scandal", "國防部爆發間諜疑雲",
    "安全局逮捕一名涉嫌向「東沙公國」洩漏國防機密的軍官，國防部內部人心惶惶，議員要求質詢。", 8,
    ["公開調查並整頓安檢", "國庫支出調查費，議會與政治支持上升，軍方不安", { money: -1200, parliamentSatisfaction: 8, politicalSupport: 6, militarySatisfaction: -5 }],
    ["秘密審判並肅清軍中反對派", "軍方強烈反彈，穩定暴跌且有內戰風險", { militarySatisfaction: -12, stability: -15, politicalSupport: 5, civilWarRisk: true }],
    ["內部低調調查處理", "議會不滿，政治支持微幅下降", { parliamentSatisfaction: -4, politicalSupport: -2 }]),

  ev("diplomacy", "dip_refugee_crisis", "邊境爆發難民潮",
    "鄰國「南島聯邦」內戰升溫，數千名難民湧入邊界地區，地方政府告急要求中央撥款收容。", 9,
    ["設置庇護所並提供救援", "國庫大失血，穩定與議會略升，軍方不滿", { money: -2500, stability: 5, parliamentSatisfaction: 6, militarySatisfaction: -5 }],
    ["派兵封鎖邊境強行遣返", "軍方與政治支持上升，但穩定下降且具內戰風險", { militarySatisfaction: 10, politicalSupport: 6, stability: -12, civilWarRisk: true }],
    ["劃定臨時安置區觀望", "國庫少許支出，穩定度微幅下滑", { money: -500, stability: -4 }]),

  ev("diplomacy", "dip_embargo_threat", "強權威脅實施禁運",
    "經濟大國「西薩帝國」要求我國關閉對特種物資的出口，否則將實施全面貿易禁運。", 8,
    ["簽署貿易妥協協定", "國庫給付補償金，穩定與議會上升，政治支持受損", { money: -2000, stability: 6, parliamentSatisfaction: 6, politicalSupport: -5 }],
    ["宣佈對等報復與反關稅", "軍方與支持度上升，但國庫損失與穩定暴跌且有內戰風險", { militarySatisfaction: 10, politicalSupport: 8, money: -1500, stability: -10, civilWarRisk: true }],
    ["拖延談判聲稱內部研議", "國庫經濟觀望受影響", { money: -750, politicalSupport: -3 }]),

  ev("diplomacy", "dip_consulate_incident", "外國領事館尋求庇護",
    "一位「蒼原王國」的反對派政要闖入我國駐外領事館要求政治庇護，引發兩國外交緊張。", 7,
    ["批准庇護安排轉移", "花費維安與外交經費，議會與支持上升，軍方擔憂", { money: -1200, parliamentSatisfaction: 8, politicalSupport: 7, militarySatisfaction: -5 }],
    ["拒絕庇護並強行移交", "軍方支持，但議會與穩定大降且具內戰風險", { militarySatisfaction: 8, parliamentSatisfaction: -10, stability: -12, civilWarRisk: true }],
    ["滯留領館進行法理研議", "議會與政治支持略降", { parliamentSatisfaction: -3, politicalSupport: -3 }]),

  ev("diplomacy", "dip_fishing_dispute", "爭議海域漁權糾紛",
    "我國漁船在爭議海域遭「白山合眾國」海巡艇扣留，漁民團體聚集行政院門口抗議要求救援。", 8,
    ["支付保釋金並協議劃界", "國庫失血，穩定與議會回升，軍方滿意度下降", { money: -1750, stability: 5, parliamentSatisfaction: 6, militarySatisfaction: -6 }],
    ["派遣軍艦強行開赴爭議海域", "軍方與民間挺政府，但穩定大降且具內戰風險", { militarySatisfaction: 12, politicalSupport: 8, stability: -12, civilWarRisk: true }],
    ["發函照會並勸導漁民避開", "政治支持與穩定略微下滑", { politicalSupport: -4, stability: -3 }]),

  ev("diplomacy", "dip_media_smear", "外媒刊登抹黑報導",
    "「翡翠聯邦」主流媒體發表專題報導，指控我國政府違反人權與貪腐，引發國際輿論關注。", 6,
    ["聘請公關公司澄清說明", "國庫支出公關費，政治支持與議會上升", { money: -1500, politicalSupport: 8, parliamentSatisfaction: 6 }],
    ["封鎖媒體門戶並驅逐記者", "軍方認同，但穩定與議會下滑且具內戰風險", { militarySatisfaction: 8, stability: -10, parliamentSatisfaction: -8, civilWarRisk: true }],
    ["發表簡短聲明冷處理", "政治支持度小幅下降", { politicalSupport: -5 }]),

  ev("diplomacy", "dip_diaspora_dispute", "外國僑民暴動糾紛",
    "首都發生「金沙共和國」僑民與本土民眾群鬥事件，該國使館要求我方懲凶並支付賠償。", 7,
    ["撥款賠償並加強警察巡邏", "國庫失血，穩定度上升，軍方與支持度受損", { money: -1750, stability: 7, militarySatisfaction: -5, politicalSupport: -5 }],
    ["動員警力大舉逮捕違法僑民", "軍方與支持度提升，但穩定下滑且具內戰風險", { militarySatisfaction: 10, politicalSupport: 8, stability: -10, civilWarRisk: true }],
    ["指示地方政府組調查小組", "穩定度與議會小幅下降", { stability: -3, parliamentSatisfaction: -3 }]),

  ev("diplomacy", "dip_embassy_attack", "駐外使館遭暴民襲擊",
    "我國駐「黑森林王國」大使館遭暴民投擲汽油彈襲擊，館員受傷，外交部急電請示因應策略。", 8,
    ["撥款協助修繕並維持對話", "國庫大失血，穩定與議會回升，軍方不滿", { money: -2250, stability: 6, parliamentSatisfaction: 6, militarySatisfaction: -6 }],
    ["召回大使並實施經濟制裁", "軍方與支持度大幅提升，但穩定暴跌且具內戰風險", { militarySatisfaction: 14, politicalSupport: 10, stability: -12, civilWarRisk: true }],
    ["暫停部分業務靜觀其變", "政治支持與穩定略降", { politicalSupport: -4, stability: -3 }]),
];
