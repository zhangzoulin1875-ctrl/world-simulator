import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 公共衛生(10):瘟疫、飢荒、藥品短缺、水源汙染、醫護罷工、疫苗爭議、食品安全、傳染病、醫院超載、營養不良 */
export const HEALTH_EVENTS: readonly DomesticEventDef[] = [
  ev("health", "hlt_epidemic_outbreak", "地方爆發灰斑熱疫情",
    "邊陲省份突發未知熱病「灰斑熱」,染病者皮膚潰爛發燒,疫情沿著貿易公路迅速擴散。", 10,
    ["撥款建立封鎖線與救治站", "穩定與議會回升,國庫失血", { money: -2500, stability: 6, parliamentSatisfaction: 4 }],
    ["派軍隊封鎖省界強制隔離", "軍方支持,但穩定與政治支持大跌且有內戰風險", { militarySatisfaction: 12, stability: -15, politicalSupport: -8, civilWarRisk: true }],
    ["暫時觀望,僅發布衛生指引", "穩定與政治支持下滑", { stability: -5, politicalSupport: -3 }]),

  ev("health", "hlt_famine_malnutrition", "歉收引發嚴重營養不良",
    "主要糧產區遭遇極端天候致農作物大歉收,底層民眾面臨嚴重飢荒與大規模營養不良。", 9,
    ["動用國庫採購糧食平抑物價", "穩定與政治支持回升,國庫失血", { money: -2000, stability: 8, politicalSupport: 6 }],
    ["派軍部搜查糧商管制糧食", "軍方支持,但穩定與議會下滑且有內戰風險", { militarySatisfaction: 10, stability: -14, parliamentSatisfaction: -6, civilWarRisk: true }],
    ["呼籲民間慈善機構自主救濟", "穩定與政治支持下滑", { stability: -6, politicalSupport: -4 }]),

  ev("health", "hlt_medicine_shortage", "全國面臨關鍵藥品短缺",
    "治療「藍髓熱」的核心原料藥供應中斷,各大藥局與診所面臨斷藥危機,民眾人心惶惶。", 8,
    ["高價自國外急調急救藥物", "穩定與政治支持回升,國庫負擔沉重", { money: -2250, stability: 7, politicalSupport: 5 }],
    ["軍管國內藥廠並實施配給", "軍方支持,但穩定與政治支持暴跌且有內戰風險", { militarySatisfaction: 8, stability: -12, politicalSupport: -8, civilWarRisk: true }],
    ["組建調查小組評估缺藥狀況", "穩定與議會滿意下滑", { stability: -4, parliamentSatisfaction: -4 }]),

  ev("health", "hlt_water_contamination", "首都水源遭重金屬汙染",
    "首都圈主要飲用水源檢測出高濃度「苔毒」化學殘留,數萬居民出現噁心發燒症狀。", 8,
    ["緊急撥款鋪設新管線與濾水", "穩定與議會回升,國庫支出龐大", { money: -2500, stability: 8, parliamentSatisfaction: 4 }],
    ["封鎖污染資訊並軍管取水處", "軍方支持,但穩定與政治支持大跌且有內戰風險", { militarySatisfaction: 10, stability: -16, politicalSupport: -6, civilWarRisk: true }],
    ["發布煮沸水告示靜待自然稀釋", "穩定與政治支持下滑", { stability: -5, politicalSupport: -4 }]),

  ev("health", "hlt_medical_strike", "全國公立醫院醫護罷工",
    "公立醫院醫護人員因津貼停發與長期超時工作爆發大規模罷工,多數急診室陷入癱瘓。", 7,
    ["同意調升醫護薪資與防疫津貼", "議會與穩定回升,國庫支出增加", { money: -1750, parliamentSatisfaction: 8, stability: 5 }],
    ["頒布緊急狀態派軍醫接管醫院", "軍方支持,但穩定與政治支持劇降且有內戰風險", { militarySatisfaction: 9, stability: -15, politicalSupport: -7, civilWarRisk: true }],
    ["組建勞資協商委員會延後表態", "議會與穩定下滑", { parliamentSatisfaction: -5, stability: -3 }]),

  ev("health", "hlt_vaccine_controversy", "防熱疫苗爆發安全爭議",
    "新推行應對「沸血熱」的疫苗被指控含有嚴重神經毒性副作用,民眾抗拒接種並引發騷亂。", 7,
    ["採購進口檢驗合格的新型疫苗", "穩定與政治支持回升,國庫支出增加", { money: -2000, stability: 6, politicalSupport: 5 }],
    ["強制全體國民接種違者派兵逮捕", "軍方支持,但穩定與政治支持暴跌且有內戰風險", { militarySatisfaction: 10, stability: -18, politicalSupport: -8, civilWarRisk: true }],
    ["暫緩推廣並成立安全再審委員會", "政治支持與穩定下滑", { politicalSupport: -5, stability: -4 }]),

  ev("health", "hlt_food_safety_scandal", "黑心罐頭引發食物中毒",
    "供應商提供含有「紫腐毒素」的黑心罐頭給軍隊與學校,造成數千人集體中毒入院。", 7,
    ["嚴懲黑心廠商並發放健康賠償", "政治支持與議會回升,國庫失血", { money: -1500, politicalSupport: 7, parliamentSatisfaction: 5 }],
    ["憲兵扣押涉案軍糧廠接管物資", "軍方支持,但穩定與政治支持下滑且有內戰風險", { militarySatisfaction: 11, stability: -12, politicalSupport: -7, civilWarRisk: true }],
    ["交由衛生局下週統一發布調查", "政治支持與議會下滑", { politicalSupport: -4, parliamentSatisfaction: -3 }]),

  ev("health", "hlt_contagious_fever", "港口鎮爆發寒斑風疫情",
    "繁忙的外貿港口傳出急性傳染病「寒斑風」案例,患病者迅速呼吸衰竭,商港陷入恐慌。", 8,
    ["撥款建立檢疫港口與集中救治", "穩定與議會回升,國庫花費巨大", { money: -2250, stability: 7, parliamentSatisfaction: 4 }],
    ["派海軍封鎖港口禁止船隻出入", "軍方支持,但穩定與政治支持大跌且有內戰風險", { militarySatisfaction: 10, stability: -15, politicalSupport: -8, civilWarRisk: true }],
    ["僅對入境船員實施體溫自主申報", "穩定與政治支持下滑", { stability: -5, politicalSupport: -3 }]),

  ev("health", "hlt_hospital_overload", "首都醫院爆發超載危機",
    "因患有「裂肺熱」的病患暴增,首都各大醫院病床與呼吸設備耗盡,大量患者躺在走廊。", 8,
    ["動用備用金緊急擴建野戰醫院", "穩定與政治支持回升,國庫支出龐大", { money: -2500, stability: 8, politicalSupport: 5 }],
    ["派軍隊實施分流並徵用私立醫院", "軍方支持,但穩定與議會下滑且有內戰風險", { militarySatisfaction: 9, stability: -13, parliamentSatisfaction: -7, civilWarRisk: true }],
    ["呼籲輕症患者自主居家隔離", "穩定與政治支持下滑", { stability: -6, politicalSupport: -3 }]),

  ev("health", "hlt_slum_malnutrition", "貧民區爆發黑沼瘴氣病",
    "城市貧民區因長期衛生惡劣與營養不良,爆發慢性「黑沼瘴氣病」,底層勞工喪失勞動力。", 6,
    ["發放公共營養補給與衛生改善", "穩定與政治支持回升,國庫花費增加", { money: -1750, stability: 6, politicalSupport: 5 }],
    ["派武裝警察封鎖貧民區強制清理", "軍方支持,但穩定與政治支持大跌且有內戰風險", { militarySatisfaction: 8, stability: -16, politicalSupport: -6, civilWarRisk: true }],
    ["指示地方政府自行撥款處置", "穩定與政治支持下滑", { stability: -4, politicalSupport: -3 }]),
];
