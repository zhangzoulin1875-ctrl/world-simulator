import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 科技產業(10):新發明、工廠事故、能源短缺、礦場坍塌、鐵路興建、工業間諜、機械化失業、電力網、造船業、新式武器研發 */
export const TECH_EVENTS: readonly DomesticEventDef[] = [
  ev("tech", "tch_patent_breakthrough", "民間專利技術突破",
    "民間發明家展示新型高效率蒸汽機專利，各界關注其工業應用潛力，發明人向政府申請專利保護與研發補助。", 8,
    ["撥款資助研發並購買專利", "國庫大量支出，大幅提升穩定與政治支持", { money: -2500, stability: 5, politicalSupport: 6 }],
    ["強制徵收專利歸國家所有", "軍方獲得先進技術，但民怨沸騰且有內戰風險", { militarySatisfaction: 12, stability: -15, politicalSupport: -8, civilWarRisk: true }],
    ["擱置補助申請交由市場決定", "企業失望，政治支持微幅下降", { politicalSupport: -4, parliamentSatisfaction: -2 }]),

  ev("tech", "tch_factory_explosion", "紡織大廠蒸汽鍋爐爆炸",
    "首都郊區民營紡織廠發生嚴重蒸氣鍋爐爆炸，造成數十名工人傷亡與廠房全毀，工會群情激憤要求工安立法。", 9,
    ["發放撫恤金並頒布工安規範", "花費國庫資金，提升穩定度與議會滿意度", { money: -1750, stability: 8, parliamentSatisfaction: 6 }],
    ["逮捕工會領袖並封鎖事故現場", "軍方維穩，但引發極大民怨與內戰危機", { militarySatisfaction: 8, stability: -18, politicalSupport: -10, civilWarRisk: true }],
    ["成立調查委員會靜待報告", "拖延處置導致民間支持與穩定下滑", { stability: -4, politicalSupport: -3 }]),

  ev("tech", "tch_coal_shortage", "工業用煤炭供應告急",
    "冬季採暖與工廠用煤需求激增，主要煤礦產量不足導致煤價飛漲，多家鋼鐵廠因缺乏燃料面臨停產。", 9,
    ["提供煤炭進口補貼與燃料配給", "消耗國庫資金，大幅穩定工業生產與民生", { money: -2250, stability: 7, parliamentSatisfaction: 5 }],
    ["強制徵用私人煤庫專供軍工", "軍事滿足度上升，但商業反彈且引發治安動盪", { militarySatisfaction: 10, stability: -14, parliamentSatisfaction: -8, civilWarRisk: true }],
    ["呼籲民間節約能源不予干預", "工廠停工影響經濟，民間支持下滑", { stability: -3, politicalSupport: -4 }]),

  ev("tech", "tch_mine_disaster", "皇家鐵礦坍塌受困事故",
    "南部大型鐵礦場發生地下走廊坍塌，數十名礦工受困深處，礦工家屬包圍礦務局要求政府全面救災。", 8,
    ["調集專業裝備開展救援與救濟", "國庫支出賑濟金，獲得高滿意度與穩定", { money: -1500, stability: 8, politicalSupport: 6 }],
    ["封鎖礦場訊息避免引發恐慌", "強行維持秩序，但消息外洩後引爆強烈抗爭", { militarySatisfaction: 6, stability: -16, politicalSupport: -12, civilWarRisk: true }],
    ["責成礦場業主自行搜救", "搜救進度緩慢，民怨與議會批判不斷", { stability: -4, parliamentSatisfaction: -3 }]),

  ev("tech", "tch_railway_dispute", "幹線鐵路用地徵收爭議",
    "國家鐵路延伸計畫行經農耕重鎮，地主與農民聯合阻撓工程進行，要求更高額補償否則集體抗爭。", 8,
    ["提高土地補償金並改道保護農田", "花費龐大國庫資金，化解民怨並取得議會支持", { money: -2500, stability: 6, parliamentSatisfaction: 6 }],
    ["出動工兵部隊強制拆遷與鋪軌", "軍方執行力提升，但引發地方暴動與內戰危機", { militarySatisfaction: 10, stability: -15, politicalSupport: -8, civilWarRisk: true }],
    ["暫停興建成立地價協商委員會", "工期延誤導致政務效率與民間信心受損", { stability: -2, politicalSupport: -4 }]),

  ev("tech", "tch_industrial_espionage", "軍工鋼鐵密方外洩疑雲",
    "國家造船廠最新合金鋼配方遭人偷拍盜走，情報部門懷疑敵國間諜滲透高層，議會要求即刻調查。", 7,
    ["重金懸賞緝兇並強化安全機制", "國庫支付保密預算，提升政治支持與議會信任", { money: -1250, politicalSupport: 7, parliamentSatisfaction: 6 }],
    ["逮捕廠內全體工程師進行酷刑審訊", "軍方嚴管治安，但摧毀知識份子信任與穩定", { militarySatisfaction: 10, stability: -14, parliamentSatisfaction: -10, civilWarRisk: true }],
    ["內部調查靜觀其變避免打草驚蛇", "洩密陰影不散，軍方與議會滿意度微降", { militarySatisfaction: -3, parliamentSatisfaction: -3 }]),

  ev("tech", "tch_automation_unrest", "自動紡織機引發砸機風潮",
    "新式自動蒸汽紡織機引進後大批傳統手工業者失業，失業工人組隊夜襲工廠砸毀機器，衝突持續擴大。", 8,
    ["設立失業轉職救濟金與專責機構", "國庫安撫民怨，提升社會穩定與民間支持", { money: -2000, stability: 7, politicalSupport: 5 }],
    ["派遣憲兵保護工廠並嚴懲砸機者", "保障資方利益與軍方地位，但爆發大規模動亂", { militarySatisfaction: 8, stability: -18, parliamentSatisfaction: -6, civilWarRisk: true }],
    ["勸導雙方理性克制不予補貼", "失業問題未解，穩定度持續微幅下降", { stability: -4, politicalSupport: -3 }]),

  ev("tech", "tch_power_grid_expansion", "首都路燈電力網試驗計劃",
    "工程師成功研發直流發電機與弧光燈，提議興建城市電力網路取代傳統瓦斯路燈，大幅改善夜間治安。", 7,
    ["撥款全額資助電網基礎建設", "國庫大幅支出，大幅促進現代化與政治支持", { money: -2500, politicalSupport: 8, stability: 5 }],
    ["強行接管電力公司專供軍營發電", "軍方設施獲優先電網，但民間與議會強烈不滿", { militarySatisfaction: 12, parliamentSatisfaction: -10, stability: -8, civilWarRisk: true }],
    ["僅核准小規模私人社區試辦", "電網普及緩慢，議會期待落空", { parliamentSatisfaction: -3, politicalSupport: -2 }]),

  ev("tech", "tch_shipyard_steam_ironclad", "裝甲蒸氣戰艦造船技術",
    "國家造船廠提出全鐵殼蒸氣戰艦建造方案，稱可大幅躍升海軍實力，但所需材料與造價極為昂貴。", 7,
    ["編列專案預算建造新式鐵甲艦", "花費鉅額國庫資金，軍方與議會極度滿意", { money: -2500, militarySatisfaction: 10, parliamentSatisfaction: 4 }],
    ["強行扣押民營船廠設施與鋼材", "軍方滿足度大增，但摧毀造船業界信心且引發暴動", { militarySatisfaction: 14, stability: -12, politicalSupport: -8, civilWarRisk: true }],
    ["僅授權進行小型模型與圖紙評估", "技術發展停滯，軍方頗有微詞", { militarySatisfaction: -5, politicalSupport: -2 }]),

  ev("tech", "tch_breech_loading_artillery", "後裝鋼製線膛砲研發突破",
    "皇家兵工廠試製成功射程與精度遠勝舊式前裝砲的鋼製線膛砲，軍方迫不及待要求量產換裝。", 8,
    ["撥款更新兵工廠生產線進行換裝", "國庫龐大支出，軍方滿意度與政治支持大幅提升", { money: -2250, militarySatisfaction: 11, politicalSupport: 4 }],
    ["全面管制鋼材與黑火藥民間流通", "軍事控制力大幅提升，但民間商業慘澹引發不滿", { militarySatisfaction: 12, stability: -12, parliamentSatisfaction: -7, civilWarRisk: true }],
    ["要求兵工廠繼續測試暫緩大規模量產", "換裝延宕，軍方極度不滿", { militarySatisfaction: -6, stability: -2 }]),
];
