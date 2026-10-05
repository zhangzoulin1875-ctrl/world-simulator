import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 社會(10):示威、犯罪、移民、住房、貧富、勞工、少族、暴動、外流、流浪 */
export const SOCIETY_EVENTS: readonly DomesticEventDef[] = [
  ev("society", "soc_mass_demonstration", "全國性萬人抗議示威",
    "因不滿生活成本高漲與政府施政，數萬名民眾湧入首都廣場進行集會，要求內閣下台並進行全面改組。", 10,
    ["承諾撥款補貼並召開對話", "大幅平息民間怒火，但國庫失血且軍方不滿", { stability: 10, money: -2000, parliamentSatisfaction: 4, militarySatisfaction: -4 }],
    ["動員防暴警察水砲清場", "軍方滿意，但穩定與政治支持重挫且有內戰風險", { stability: -15, militarySatisfaction: 10, politicalSupport: -8, parliamentSatisfaction: -5, civilWarRisk: true }],
    ["呼籲民眾理性並持續觀察", "未及時處置，民間不滿小幅累積", { stability: -4, politicalSupport: -3 }]),

  ev("society", "soc_crime_wave", "幫派治安危機爆發",
    "黑幫暴力犯罪事件在各大城市頻傳，商家屢遭勒索與槍擊，社會輿論強烈要求政府重整治安。", 9,
    ["擴編警察預算與社區巡邏", "穩定度與政治支持回升，但需增加財政支出", { stability: 8, politicalSupport: 6, money: -1500, parliamentSatisfaction: 3 }],
    ["頒布戒嚴命令全城搜捕", "軍方大力支持，但侵害人權引發議會反彈與內戰風險", { militarySatisfaction: 10, stability: -12, parliamentSatisfaction: -10, politicalSupport: -6, civilWarRisk: true }],
    ["成立專案小組研議對策", "治安未見改善，民眾治安信心下滑", { stability: -3, politicalSupport: -3 }]),

  ev("society", "soc_immigration_wave", "邊境難民大量湧入",
    "鄰國戰亂導致數萬難民越過邊境湧入，沿海與邊境城鎮資源緊繃，在地居民與難民衝突不斷。", 8,
    ["建立收容所並發放人道救援", "議會與國際聲譽上升，但花費鉅款且軍方不滿", { parliamentSatisfaction: 8, money: -2200, militarySatisfaction: -5, stability: 3 }],
    ["派遣軍隊封鎖邊境強行驅逐", "軍方支持，但遭議會撻伐且可能引發局勢升級", { militarySatisfaction: 12, parliamentSatisfaction: -12, politicalSupport: -8, stability: -6, civilWarRisk: true }],
    ["暫時關閉部分關卡靜觀其變", "邊境混亂持續，穩定度微幅下降", { stability: -5, politicalSupport: -2 }]),

  ev("society", "soc_housing_shortage", "都會區住房危機爆發",
    "都會區房價與租金飆漲，年輕世代與中產階級不堪重負，團體佔據空置大樓抗議居住不公。", 8,
    ["興建社會住宅並補貼租金", "穩定度與議會大幅上升，但國庫負擔極重", { stability: 8, parliamentSatisfaction: 8, money: -2500, politicalSupport: 4 }],
    ["出動警力強制驅離佔領者", "保護房產市場，但引發民怨暴動與內戰風險", { stability: -14, politicalSupport: -12, militarySatisfaction: 6, parliamentSatisfaction: -6, civilWarRisk: true }],
    ["組設房價研議委員會", "無法解決實質問題，民間不滿增加", { politicalSupport: -5, stability: -3 }]),

  ev("society", "soc_wealth_inequality", "貧富差距引發階級對立",
    "最新的經濟報告指出國內貧富差距創歷史新高，底層勞工發起抗爭，要求富人增稅與再分配。", 7,
    ["開徵富人稅並擴大社會福利", "國庫進帳且議會滿意，但政商關係緊張與穩定動盪", { money: 2000, parliamentSatisfaction: 8, politicalSupport: -6, stability: -4 }],
    ["查禁左翼組織並壓制訴求", "軍方支持，但引發底層群眾強烈反彈與內戰風險", { militarySatisfaction: 10, stability: -16, parliamentSatisfaction: -8, politicalSupport: -4, civilWarRisk: true }],
    ["宣導經濟成長成果共享", "無法弭平對立，政治支持微幅下降", { politicalSupport: -4, stability: -2 }]),

  ev("society", "soc_labor_strike", "全國跨行業聯合大罷工",
    "工會因工資談判破裂發動跨行業大罷工，鐵路、港口與公共運輸全面癱瘓，經濟運作陷入停擺。", 9,
    ["調升基本工資並滿足工會要求", "平息罷工並提升議會支持，但國庫需補貼公共事業", { stability: 10, parliamentSatisfaction: 8, money: -2000, politicalSupport: 3 }],
    ["宣布罷工違法並接管重要設施", "軍方接管維持運作，但引發工人激烈抗爭與內戰風險", { militarySatisfaction: 12, stability: -15, parliamentSatisfaction: -10, politicalSupport: -3, civilWarRisk: true }],
    ["指定第三方進行勞資協調", "談判進度緩慢，交通營運小幅受阻", { money: -500, stability: -4 }]),

  ev("society", "soc_minority_conflict", "少數族群種族衝突爆發",
    "少數族群居住區爆發族群衝突事件，雙方陣營爆發肢體鬥毆並焚燒店面，仇恨情緒迅速蔓延。", 7,
    ["劃設文化保護區與經濟補助", "緩和族群緊張，但需消耗財政預算且軍方懷疑", { stability: 8, parliamentSatisfaction: 6, money: -1600, militarySatisfaction: -4 }],
    ["派兵駐紮衝突區實施宵禁", "軍方強勢壓制，但造成局勢急劇惡化並帶來內戰風險", { militarySatisfaction: 10, stability: -16, politicalSupport: -8, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["呼籲各方克制並派員調解", "衝突隨時可能再發，穩定度稍微下降", { stability: -5, politicalSupport: -2 }]),

  ev("society", "soc_urban_riot", "首都夜間街頭暴動",
    "警方執法爭議引發群眾聚集，夜間演變為大規模騷亂，商業區多家店鋪遭到搶劫與縱火。", 8,
    ["成立獨立調查會並賠償店家", "政治支持與議會平息，但撥款賠償國庫受損", { politicalSupport: 8, parliamentSatisfaction: 6, money: -1800, stability: 4 }],
    ["部署裝甲車進行暴力鎮壓", "軍方迅速掌握街頭，但民眾積怨深重與內戰風險", { militarySatisfaction: 12, stability: -18, parliamentSatisfaction: -8, politicalSupport: -2, civilWarRisk: true }],
    ["增派巡邏警戒，暫不採取大動作", "騷亂餘波未平，社會秩序受損", { stability: -6, money: -500 }]),

  ev("society", "soc_brain_drain", "青年專業人才外流潮",
    "因國內薪資停滯與前景不明，大量高科技人才與醫生選擇移居海外，產業面臨嚴重人才斷層。", 6,
    ["提供留任租稅優惠與創業補貼", "減緩人才外流，但政府稅收減損且花費補貼", { stability: 6, parliamentSatisfaction: 6, money: -2200, politicalSupport: 4 }],
    ["限制特定專業人士出境申請", "強行留住人腦，但引發極大民憤、議會指責與內戰風險", { stability: -15, parliamentSatisfaction: -12, politicalSupport: -10, militarySatisfaction: 2, civilWarRisk: true }],
    ["舉辦留才青年交流座談會", "象徵性宣導，無法阻止人才流失", { politicalSupport: -4, stability: -2 }]),

  ev("society", "soc_homeless_crisis", "寒冬無家可歸者危機",
    "寒流來襲導致街頭無家可歸者凍死事件頻傳，慈善團體發起抗議，要求政府提供急難收容設施。", 6,
    ["緊急採購庇護所設施與物資", "提升社會安定與政治支持，需動用預備金", { stability: 8, politicalSupport: 8, money: -1750, parliamentSatisfaction: 4 }],
    ["強制將流浪者驅離市中心區域", "維護市容，但引發社會輿論強烈指責與內戰風險", { stability: -10, politicalSupport: -12, parliamentSatisfaction: -8, militarySatisfaction: 5, civilWarRisk: true }],
    ["呼籲民間慈善機構主動協助", "政府缺乏作為，遭受輿論批評", { politicalSupport: -5, stability: -2 }]),
];
