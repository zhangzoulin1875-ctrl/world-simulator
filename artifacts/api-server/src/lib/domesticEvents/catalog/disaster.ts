import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 天災(10):地震、洪水、旱災、颱風、火山、蝗災、森林大火、雪災、山崩、海嘯 */
export const DISASTER_EVENTS: readonly DomesticEventDef[] = [
  ev("disaster", "dis_earthquake_valen", "瓦倫省爆發強烈地震",
    "瓦倫省清晨發生芮氏規模強震，大量民房塌陷並造成嚴重傷亡，救援物資與醫療資源急需調撥。", 10,
    ["動用國庫預算全力賑災", "安定災民情緒，獲得政治支持，但國庫大失血", { money: -2000, stability: 8, politicalSupport: 8, parliamentSatisfaction: 4 }],
    ["派遣軍隊接管封鎖災區", "軍方展現效率與主導權，但引發群眾恐慌與不滿", { militarySatisfaction: 10, stability: -12, politicalSupport: -8, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["下令地方政府自行處理", "救援延誤引發民怨，穩定與政治支持下滑", { stability: -6, politicalSupport: -6 }]),

  ev("disaster", "dis_flood_elba", "厄爾巴大河暴漲成災",
    "連日豪雨導致厄爾巴大河潰堤，沿岸農田與城鎮遭洪水淹沒，交通中斷且數萬民眾流離失所。", 9,
    ["撥款修建堤防並救濟災民", "穩定度與議會支持上升，但財政負擔沉重", { money: -1750, stability: 7, politicalSupport: 6, parliamentSatisfaction: 5 }],
    ["徵調民間物資並實施宵禁", "軍方得以掌控秩序，但引發民間強烈抗議", { militarySatisfaction: 8, stability: -10, politicalSupport: -8, parliamentSatisfaction: -6, civilWarRisk: true }],
    ["設立委員會再評估災情", "災情持續惡化，穩定度與政治支持下降", { stability: -5, politicalSupport: -5 }]),

  ev("disaster", "dis_solis_drought", "索里斯平原遭遇大旱",
    "索里斯平原連續數月滴雨未下，農作物大量枯死，水庫蓄水告急，糧食價格急遽飆漲。", 8,
    ["進口糧食並補貼受災農民", "穩定物價與人心，獲得民意支持，但消耗大量資金", { money: -2250, stability: 6, politicalSupport: 8 }],
    ["強行管制糧食配給與價格", "軍方嚴加監管防堵囤積，但市場混亂反彈強烈", { militarySatisfaction: 7, stability: -14, politicalSupport: -6, parliamentSatisfaction: -5, civilWarRisk: true }],
    ["呼籲民眾節約用水", "糧價持續飆漲，民怨積聚使穩定與支持度受損", { stability: -4, politicalSupport: -5, parliamentSatisfaction: -2 }]),

  ev("disaster", "dis_typhoon_astra", "超級颱風襲擊東海岸",
    "強烈颱風阿斯特拉直撲東部港灣，狂風暴雨摧毀大量基礎設施，沿海電力與通訊全面中斷。", 9,
    ["緊急搶修設施並發放救濟金", "社會迅速恢復秩序，民意與議會滿意，但花費龐大", { money: -1500, stability: 8, politicalSupport: 6, parliamentSatisfaction: 4 }],
    ["宣布東海岸進入緊急狀態", "工兵與軍隊全面接管管制，引發居民恐慌與衝突", { militarySatisfaction: 10, stability: -11, politicalSupport: -7, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["等待颱風離境後再研議", "災後重建進度緩慢，政治支持與穩定下滑", { stability: -4, politicalSupport: -4 }]),

  ev("disaster", "dis_volcano_ignis", "奧斯山火山劇烈噴發",
    "沉寂多年的奧斯火山噴出大量灰燼與熔岩，周邊村落受火山灰籠罩，航班與陸路交通全數中斷。", 7,
    ["大規模撤離居民並安置災民", "民心安定且議會讚許，但避難與安頓費用昂貴", { money: -2500, stability: 7, politicalSupport: 7, parliamentSatisfaction: 5 }],
    ["封鎖火山周邊區域並強制清空", "軍方嚴格執行強制拉伕與封鎖，民怨急升", { militarySatisfaction: 9, stability: -15, politicalSupport: -8, civilWarRisk: true }],
    ["監測火山活動再做打算", "空氣品質惡化與物資短缺使穩定與支持度下滑", { stability: -7, politicalSupport: -5 }]),

  ev("disaster", "dis_locust_swarm", "億萬蝗蟲肆虐糧倉",
    "龐大蝗蟲群自境外突襲中部農業大省，數十萬公頃作物被吞噬殆盡，面臨嚴峻的糧食危機。", 8,
    ["動用備邊資金採購除蟲藥劑", "有效遏止蝗害擴散，農民讚揚政府，國庫負擔加重", { money: -1250, stability: 6, politicalSupport: 8, parliamentSatisfaction: 4 }],
    ["徵集民力強行撲滅並徵收餘糧", "軍方主導強收物資，穩定與政治支持大幅受損", { militarySatisfaction: 8, stability: -12, politicalSupport: -9, parliamentSatisfaction: -5, civilWarRisk: true }],
    ["靜待蝗群自然遷徙過境", "農作物損失慘重，糧價暴漲使穩定與支持度下滑", { stability: -5, politicalSupport: -5, parliamentSatisfaction: -3 }]),

  ev("disaster", "dis_forest_fire", "烈火蔓延諾瓦林區",
    "諾瓦大森林因乾旱引發連日山火，火勢隨強風迅速擴散，威脅鄰近城鎮與重要工業園區。", 7,
    ["租用救火機隊與動員消防隊", "及時控制火勢保護產權，民意與議會支持，但開銷龐大", { money: -2000, stability: 7, politicalSupport: 6, parliamentSatisfaction: 4 }],
    ["調集國防軍進入林區建立防火線", "軍事動員效率高，但強拆沿線民房引發民憤", { militarySatisfaction: 9, stability: -11, politicalSupport: -8, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["等待降雨緩和火勢", "林區受災擴大與煙霧污染使穩定度與政治支持受損", { stability: -5, politicalSupport: -4 }]),

  ev("disaster", "dis_snowstorm_frost", "罕見暴風雪癱瘓北境",
    "北境山區遭受數十年來最嚴重的暴風雪襲擊，道路積雪數尺，數個市鎮面臨斷糧與缺煤危機。", 8,
    ["調撥特別預算運送燃料與食物", "拯救受困居民使民意與議會回升，但運輸開銷巨大", { money: -1750, stability: 7, politicalSupport: 7, parliamentSatisfaction: 4 }],
    ["派裝甲部隊強行開路並限制糧食買賣", "軍方主導物資配給，但管制嚴苛引發民眾反抗", { militarySatisfaction: 10, stability: -12, politicalSupport: -7, parliamentSatisfaction: -5, civilWarRisk: true }],
    ["指示地方自治體自籌救災", "凍死與缺糧事件頻傳，穩定度與政治支持受重創", { stability: -6, politicalSupport: -5 }]),

  ev("disaster", "dis_landslide_gorge", "喀爾特山脈崩塌土石",
    "連日豪雨引發喀爾特山脈大規模土石流，下方的礦業小鎮遭受掩埋，主要鐵路線與道路受阻。", 6,
    ["投入大量工程機具與搶救隊", "救援生還者並修復鐵路，安定人心，花費可觀資金", { money: -1500, stability: 6, politicalSupport: 7, parliamentSatisfaction: 4 }],
    ["徵用民間重型機械並戒嚴災區", "軍方掌控搜救與礦區防衛，但強制徵用民產引發衝突", { militarySatisfaction: 8, stability: -10, politicalSupport: -8, parliamentSatisfaction: -4, civilWarRisk: true }],
    ["先評估土石穩定度再行進駐", "錯失黃金救援時間，穩定度與政治支持顯著下滑", { stability: -5, politicalSupport: -4 }]),

  ev("disaster", "dis_tsunami_coast", "巨浪突襲西境港口城",
    "外海強震引發滔天巨浪侵襲西境商業港城，港口設施與周邊商圈毀損嚴重，經濟活動瞬間停擺。", 7,
    ["資助港口重構與發放商家津貼", "促進復工復產，民意與議會滿意，但國庫承擔極大花費", { money: -2250, stability: 8, politicalSupport: 7, parliamentSatisfaction: 5 }],
    ["封鎖海岸線並出動憲兵管制港區", "保護國營港埠設施，但商家罷工與居民抗議蔓延", { militarySatisfaction: 9, stability: -13, politicalSupport: -9, parliamentSatisfaction: -5, civilWarRisk: true }],
    ["成立調查小組統計損失金額", "災後復原牛步，穩定度與政治支持受損", { stability: -6, politicalSupport: -5, parliamentSatisfaction: -2 }]),
];
