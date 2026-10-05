import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 宗教(10):教派衝突、朝聖、神職人員、異端、節慶、神蹟、地產、傳教、新興教派 */
export const RELIGION_EVENTS: readonly DomesticEventDef[] = [
  // ── 原有事件 ──
  ev("religion", "religious_revival", "宗教復興運動",
    "各地教會集會日益頻繁,信眾要求政府重新確立信仰在公共生活中的地位。", 6,
    ["扶持教會,給予特權", "議會與支持度上升,軍方略有疑慮", { parliamentSatisfaction: 6, politicalSupport: 6, militarySatisfaction: -3 }],
    ["強行世俗化,取締集會", "軍方支持,但穩定與議會下滑", { stability: -10, militarySatisfaction: 6, parliamentSatisfaction: -6 }],
    ["保持中立", "議會略降", { parliamentSatisfaction: -2 }]),

  // ── 新增 ──
  ev("religion", "rel_heresy_trial", "秘密異端裁判所",
    "山居教團私設審判所扣押異端學者,民間團體抗議侵害人權,要求司法介入。", 7,
    ["派員取締私設裁判", "穩定與政治支持上升,但教團不滿", { stability: 6, politicalSupport: 8, parliamentSatisfaction: 4, money: -500 }],
    ["特種武力查禁教團", "軍方支持,但穩定下降且有內戰風險", { militarySatisfaction: 10, stability: -12, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["指示法務部門研議", "政治支持下滑", { politicalSupport: -5 }]),

  ev("religion", "rel_pilgrimage_dispute", "聖地朝聖封路爭議",
    "星輝聖教年度朝聖活動封鎖主要商道,商人聯合罷市要求政府恢復交通。", 8,
    ["規劃專用朝聖通道", "國庫撥款維護,議會與穩定回升", { money: -1000, stability: 5, parliamentSatisfaction: 6 }],
    ["派遣憲兵強行開路", "軍方支持,但信眾抗議導致穩定暴跌", { militarySatisfaction: 8, stability: -14, politicalSupport: -4, civilWarRisk: true }],
    ["呼籲雙方理性克制", "政治支持與穩定略降", { politicalSupport: -3, stability: -2 }]),

  ev("religion", "rel_clergy_politics", "主教公開干預大選",
    "靈曦教社大主教在主日講道中指責政府政策,並號召信徒投給指定反對派。", 7,
    ["拜會大主教尋求和解", "政治支持與議會回升,但軍方不快", { politicalSupport: 8, parliamentSatisfaction: 6, militarySatisfaction: -4 }],
    ["驅逐干政神職人員", "軍方滿意,但政治支持與穩定重挫", { militarySatisfaction: 10, politicalSupport: -10, stability: -8, civilWarRisk: true }],
    ["發表聲明強調政教分離", "政治支持略降", { politicalSupport: -4 }]),

  ev("religion", "rel_sectarian_clash", "舊城教派流血衝突",
    "古木教團與月華聖堂因教義分歧在舊城爆發大規模械鬥,造成數十人傷亡。", 8,
    ["設立宗教調解委員會", "撥款撫恤傷亡者,穩定與政治支持回升", { money: -1200, stability: 6, politicalSupport: 5 }],
    ["派出軍隊實施戒嚴", "軍方強勢壓制,但穩定與議會大幅下滑", { militarySatisfaction: 12, stability: -16, parliamentSatisfaction: -6, civilWarRisk: true }],
    ["增派普通警察巡邏", "穩定度持續下滑", { stability: -5 }]),

  ev("religion", "rel_sacred_festival", "聖火同盟慶典撥款",
    "聖火同盟申請將年度聖火節列為國定假日並要求政府全額資助慶典支出。", 6,
    ["批准慶典並資助經費", "政治支持與議會上升,但國庫失血", { money: -2000, politicalSupport: 7, parliamentSatisfaction: 5 }],
    ["駁回申請並限制規模", "軍方支持世俗化,但政治支持重挫", { militarySatisfaction: 6, politicalSupport: -12, stability: -6 }],
    ["僅授權地方政府自行辦理", "議會滿意度微降", { parliamentSatisfaction: -3 }]),

  ev("religion", "rel_miracle_rumor", "邊境村莊神蹟降臨",
    "邊境邊陲村莊傳出聖泉治癒百病,成千上萬民眾湧入引發物價波動與騷亂。", 5,
    ["派遣醫官與物資維護秩序", "國庫支出增加,但穩定與政治支持上升", { money: -1500, stability: 7, politicalSupport: 6 }],
    ["封鎖村莊宣導科學宣傳", "軍方控管秩序,但民眾極度不滿", { militarySatisfaction: 8, stability: -10, politicalSupport: -8, civilWarRisk: true }],
    ["靜觀其變不予干預", "穩定度略為下滑", { stability: -4 }]),

  ev("religion", "rel_temple_land_dispute", "光明會眾地產爭議",
    "光明會眾聲稱首都核心商業區土地為百年教產,要求強制拆遷現有店家。", 7,
    ["給予補償金並出讓用地", "國庫大量失血,但議會滿意度上升", { money: -2500, parliamentSatisfaction: 6, politicalSupport: 4 }],
    ["查封爭議地產並沒收", "軍方滿意,但政治支持與穩定下滑", { militarySatisfaction: 9, politicalSupport: -10, stability: -6, civilWarRisk: true }],
    ["移交法院長程審理", "政治支持與議會略降", { politicalSupport: -3, parliamentSatisfaction: -3 }]),

  ev("religion", "rel_foreign_missionary", "外來傳教士滲透",
    "鄰國晨曦修會派遣大量傳教士進入沿海港口,廣設講堂並發放救濟物資。", 6,
    ["規範傳教行為並依法監管", "穩定與議會回升,國庫花費檢驗費用", { stability: 6, parliamentSatisfaction: 5, money: -750 }],
    ["驅逐所有外籍傳教士", "軍方強烈支持,但政治支持與穩定受損", { militarySatisfaction: 10, politicalSupport: -8, stability: -8, civilWarRisk: true }],
    ["密切監視暫不介入", "政治支持微幅下降", { politicalSupport: -3 }]),

  ev("religion", "rel_cult_expansion", "新興教派快速擴張",
    "淨土福音會以終末預言吸收大批青年,傳出信徒變賣家產並集體失蹤。", 9,
    ["設立心靈輔導與宣導專案", "國庫撥款處理,政治支持與穩定回升", { money: -1000, politicalSupport: 7, stability: 5 }],
    ["取締該教派並逮捕高層", "軍方挺身支持,但穩定下降且具內戰風險", { militarySatisfaction: 10, stability: -12, politicalSupport: -6, civilWarRisk: true }],
    ["指示警方成立專案小組", "穩定度微幅下滑", { stability: -4 }]),
];
