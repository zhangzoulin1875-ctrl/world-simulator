import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 軍事(10):軍費、兵變、退伍軍人、軍購、徵兵、派系、邊防、軍校、軍工、逃兵 */
export const MILITARY_EVENTS: readonly DomesticEventDef[] = [
  // ── 保留的既有事件 ──
  ev("military", "military_petition", "軍方聯名請願",
    "將領們聯名上書,要求增加軍費與裝備預算,否則軍心難以維繫。", 8,
    ["批准擴編與軍費", "軍方大悅,國庫失血", { militarySatisfaction: 15, money: -2000 }],
    ["駁回並整肅請願者", "軍方大怒,但政局暫穩", { militarySatisfaction: -15, stability: 3 }],
    ["設宴安撫,不給預算", "軍方小升,政治支持略降", { militarySatisfaction: 4, politicalSupport: -4 }]),

  // ── 新增事件 ──
  ev("military", "mil_mutiny_rumor", "裝甲師傳出兵變風聲",
    "駐紮在首都近郊的裝甲師傳出軍官私下密會，疑似對政府政策不滿並籌劃兵變，情勢緊張。", 7,
    ["加給薪資並更換師長", "軍方滿意度提升，國庫大受打擊", { militarySatisfaction: 12, money: -2000, politicalSupport: -2 }],
    ["派遣忠誠憲兵逮捕連長", "軍方震怒且人心惶惶，有內戰風險", { militarySatisfaction: -14, stability: -10, civilWarRisk: true }],
    ["密派特務監視動向", "政局不安，穩定度下降", { stability: -5, militarySatisfaction: -3 }]),

  ev("military", "mil_veteran_protest", "退伍軍人聚集抗議",
    "大批退伍老兵因撫恤金調降與醫療福利不足發起遊行，封鎖了國會門口要求政府給出交代。", 8,
    ["全面調高退伍撫恤金", "退伍軍人與軍方滿意，國庫大失血", { militarySatisfaction: 10, parliamentSatisfaction: 4, money: -2000 }],
    ["驅離抗議群眾並逮捕領頭者", "穩定大受打擊，軍方強烈不滿", { stability: -10, militarySatisfaction: -12, politicalSupport: -4, civilWarRisk: true }],
    ["成立跨部會研議小組", "社會關注冷卻，政治支持微降", { politicalSupport: -4, militarySatisfaction: -2 }]),

  ev("military", "mil_arms_scandal", "軍購案爆發高額回扣",
    "獨立媒體揭露最新型戰艦採購案涉嫌嚴重虛報價格，高階將領與代理商私吞數億回扣。", 8,
    ["徹查軍購案並懲處將領", "議會與民意支持，軍方滿意度受挫", { parliamentSatisfaction: 10, politicalSupport: 8, militarySatisfaction: -8 }],
    ["查封報導媒體並拘捕記者", "軍方受保護，但政治支持與穩定暴跌", { militarySatisfaction: 8, politicalSupport: -12, stability: -8, civilWarRisk: true }],
    ["發表澄清聲明靜待研判", "議會與政治支持下滑", { parliamentSatisfaction: -6, politicalSupport: -4 }]),

  ev("military", "mil_draft_resistance", "民間爆發反徵兵思潮",
    "青年學子因延長役期法案發起全國性罷課，要求廢除義務徵兵改採全募兵制。", 7,
    ["縮短役期並增加募兵津貼", "政治支持與議會上升，軍方與國庫吃緊", { politicalSupport: 10, parliamentSatisfaction: 6, militarySatisfaction: -6, money: -1500 }],
    ["強行通過法案並逮捕抗爭者", "軍方滿意，但社會穩定大跌", { militarySatisfaction: 10, stability: -12, politicalSupport: -8, civilWarRisk: true }],
    ["宣布暫緩審議徵兵法案", "政治支持小幅下降", { politicalSupport: -5, militarySatisfaction: -3 }]),

  ev("military", "mil_faction_struggle", "將官內部派系鬥爭",
    "陸軍派與海空軍派因國防預算分配不均公開互嗆，甚至影響參謀總部的日常決策。", 6,
    ["加編特別預算均分資源", "兩派暫時緩和，國庫大吃緊", { militarySatisfaction: 10, money: -2500, politicalSupport: -2 }],
    ["強制將領提前退休並改組", "整肅派系，但軍方極度不滿且有叛亂風險", { militarySatisfaction: -16, stability: -8, civilWarRisk: true }],
    ["擱置預算分配案", "軍方滿意度持續小跌", { militarySatisfaction: -5, stability: -2 }]),

  ev("military", "mil_border_skirmish", "邊境哨所遭偷襲",
    "偏遠邊境哨所突遭鄰國不明武裝份子襲擊，軍方要求立即擴建防線並增派重兵。", 7,
    ["授權軍方增兵並興建堡壘", "軍方與政治支持上升，國庫失血", { militarySatisfaction: 12, politicalSupport: 4, money: -2000 }],
    ["實施邊境戒嚴並進行越境掃蕩", "軍方高昂，但外交緊張與穩定暴跌", { militarySatisfaction: 14, stability: -15, civilWarRisk: true }],
    ["僅發表外交抗議聲明", "軍方不滿，政治支持微降", { militarySatisfaction: -6, politicalSupport: -2 }]),

  ev("military", "mil_academy_reform", "軍校爆發思想思潮",
    "國立軍官學校學員集體發表文告，主張軍隊國家化並要求移除軍校內的政黨符號。", 6,
    ["推動軍隊國家化改革", "議會與政治支持大幅回升，軍方保守派不滿", { parliamentSatisfaction: 10, politicalSupport: 8, militarySatisfaction: -8 }],
    ["開除帶頭學員並重整軍紀", "軍方保守派認同，但議會與穩定下降", { militarySatisfaction: 8, parliamentSatisfaction: -10, stability: -6, civilWarRisk: true }],
    ["下令軍校封閉研討", "議會與政治支持小幅下降", { parliamentSatisfaction: -4, politicalSupport: -3 }]),

  ev("military", "mil_defense_monopoly", "國營軍工廠勞資罷工",
    "最大國營軍工廠工人要求提高薪資與改善安全環境，全面罷工導致彈藥生產停擺。", 7,
    ["滿足工會訴求並撥款設備改善", "議會滿意，國庫支出增加，軍方獲得補給", { parliamentSatisfaction: 8, militarySatisfaction: 6, money: -1750 }],
    ["派兵接管軍工廠強制開工", "軍方支持，但穩定度與議會滿意度大降", { militarySatisfaction: 8, stability: -10, parliamentSatisfaction: -8, civilWarRisk: true }],
    ["指派勞資調解小組協商", "產能持續停滯，軍方滿意度小跌", { militarySatisfaction: -4, politicalSupport: -2 }]),

  ev("military", "mil_deserter_crisis", "前線邊境逃兵飆升",
    "由於基層補給匱乏與軍紀鬆弛，邊境守軍出現集體逃兵現象，部分逃兵甚至持槍搶劫。", 6,
    ["發放緊急補給與改善待遇", "軍方滿意度回升，國庫支出增加", { militarySatisfaction: 12, stability: 4, money: -1500 }],
    ["組織憲兵特別搜捕隊嚴懲", "宣示軍威，但穩定度下降且引發民怨", { stability: -8, militarySatisfaction: -6, politicalSupport: -6, civilWarRisk: true }],
    ["下令地方警察協助搜捕", "治安惡化，穩定度微降", { stability: -4, politicalSupport: -2 }]),
];
