import type { DomesticEventDef } from "../types";
import { ev } from "./helper";

/** 教育文化(10):學運、報禁、科舉舞弊、大學自治、禁書、劇場諷刺、民族語言教育、文物失竊、知識分子請願、國慶典禮 */
export const CULTURE_EVENTS: readonly DomesticEventDef[] = [
  ev("culture", "cul_student_movement", "首都高校爆發大規模學運",
    "大學生因不滿近期教育法案與學費調漲，於首都廣場展開大規模罷課與靜坐，各界關切此波抗爭。", 9,
    ["撥款補貼學費並對話", "政治支持與議會回升，但國庫失血", { money: -2000, politicalSupport: 8, parliamentSatisfaction: 6 }],
    ["派遣憲兵清場並逮捕領袖", "軍方滿意，但政治支持與議會暴跌且有內戰風險", { militarySatisfaction: 10, politicalSupport: -12, parliamentSatisfaction: -10, stability: -8, civilWarRisk: true }],
    ["置之不理等待抗爭冷卻", "穩定與政治支持小幅下降", { stability: -4, politicalSupport: -3 }]),

  ev("culture", "cul_press_restriction", "民間報社聯合抗議報禁",
    "多家獨立報社因不滿新聞審查制度，聯合發行空白頭條版面，引發民間輿論強烈反彈。", 8,
    ["廢除審查並保障新聞自由", "政治支持與議會顯著回升，軍方不滿", { politicalSupport: 12, parliamentSatisfaction: 8, militarySatisfaction: -6 }],
    ["停刊違規報社並拘捕編輯", "軍方贊同，但政治支持與穩定大跌", { militarySatisfaction: 8, politicalSupport: -14, stability: -10, civilWarRisk: true }],
    ["暫不回應靜觀輿論走向", "政治支持與議會略微下滑", { politicalSupport: -4, parliamentSatisfaction: -3 }]),

  ev("culture", "cul_exam_cheating", "國家考試爆發集體舞弊",
    "高階主考官涉嫌販售國考答案，數千名考生連署舉報，社會各界對國家文官選拔制度失去信心。", 8,
    ["全面重考並撥款整頓考場", "政治支持與議會回升，但耗費國庫資金", { politicalSupport: 10, parliamentSatisfaction: 6, money: -1500 }],
    ["強行封鎖醜聞並嚴懲舉報者", "軍方支持，但政治支持暴跌且有內戰風險", { militarySatisfaction: 8, politicalSupport: -16, stability: -6, civilWarRisk: true }],
    ["成立調查小組拖延處理", "政治支持與穩定小幅受損", { politicalSupport: -5, stability: -3 }]),

  ev("culture", "cul_university_autonomy", "國立大學要求學術自治",
    "最高學府校務會議通過決議，要求政府撤回官派校長並賦予預算獨立權，獲得學界廣泛響應。", 7,
    ["立法保障大學自治與預算", "議會與政治支持上升，但國庫支出增加", { parliamentSatisfaction: 10, politicalSupport: 8, money: -1000 }],
    ["接管校園並開除異議教授", "軍方挺身支持，但議會與穩定大幅受挫", { militarySatisfaction: 10, parliamentSatisfaction: -12, stability: -10, civilWarRisk: true }],
    ["維持現狀暫不回應講訴", "議會與政治支持微幅下降", { parliamentSatisfaction: -4, politicalSupport: -3 }]),

  ev("culture", "cul_banned_books", "民間地下禁書廣為流傳",
    "一本諷刺朝政與揭露高層秘辛的黑市書籍在全國熱銷，文化審查部門面臨巨大執法壓力。", 7,
    ["解除書禁並開放出版市場", "政治支持與議會回升，軍方表達不滿", { politicalSupport: 10, parliamentSatisfaction: 6, militarySatisfaction: -5 }],
    ["搜查書店並焚毀違禁書籍", "軍方支持整肅，但穩定與支持度下挫", { militarySatisfaction: 8, stability: -10, politicalSupport: -10, civilWarRisk: true }],
    ["暗中監視但不採取大動作", "政治支持微幅下滑", { politicalSupport: -4, stability: -2 }]),

  ev("culture", "cul_theater_satire", "劇院上映諷刺內閣劇目",
    "首都知名劇院上映喜劇，將多位大臣刻畫為貪婪庸官，觀眾好評如潮，政府高層深感難堪。", 6,
    ["公開觀賞劇目展現胸懷", "政治支持與議會上升，軍方感到不悅", { politicalSupport: 10, parliamentSatisfaction: 8, militarySatisfaction: -4 }],
    ["查封劇院並逮捕編劇導演", "軍方贊同，但政治支持與穩定受創", { militarySatisfaction: 8, politicalSupport: -12, stability: -8, civilWarRisk: true }],
    ["冷處理不予官方正面回應", "政治支持小幅下降", { politicalSupport: -5, parliamentSatisfaction: -2 }]),

  ev("culture", "cul_ethnic_language", "少數民族爭取母語教學",
    "邊遠省份少數民族代表遞交請願書，要求在當地學校導入母語教學並編纂雙語教材。", 7,
    ["撥款推動雙語教育政策", "穩定與政治支持回升，耗費國庫資金", { stability: 8, politicalSupport: 6, money: -1250 }],
    ["強制全面施行官方單一語言", "軍方支持，但穩定度與議會大幅下降", { militarySatisfaction: 8, stability: -12, parliamentSatisfaction: -8, civilWarRisk: true }],
    ["組建委員會研議可行性", "穩定與政治支持小幅下降", { stability: -3, politicalSupport: -3 }]),

  ev("culture", "cul_relics_theft", "國家博物館珍貴文物失竊",
    "國家博物館內多件傳國珍寶深夜失竊，黑市傳聞已有外國買家接洽，輿論質疑維安嚴重疏漏。", 6,
    ["懸賞鉅款並重組安保團隊", "政治支持與穩定回升，國庫大幅失血", { politicalSupport: 8, stability: 4, money: -2250 }],
    ["戒嚴文化特區並審訊內部人員", "軍方滿意，但議會反彈、穩定下滑且有風險", { militarySatisfaction: 8, parliamentSatisfaction: -10, politicalSupport: -8, stability: -8, civilWarRisk: true }],
    ["成立專案小組低調搜查", "穩定與政治支持小幅受損", { stability: -4, politicalSupport: -3 }]),

  ev("culture", "cul_intellectual_petition", "知名學者聯名發表建言書",
    "數百名資深學者與文人發表公開信，呼籲政府實施各項文化改革並放寬思想言論限制。", 7,
    ["接見學者代表並採納建議", "政治支持與議會大幅上升，國庫花費撥款", { politicalSupport: 10, parliamentSatisfaction: 8, money: -750 }],
    ["批駁建言為妖言惑眾並整肅", "軍方認同，但政治支持與穩定重挫", { militarySatisfaction: 8, politicalSupport: -14, stability: -10, civilWarRisk: true }],
    ["禮貌性收下信件但不做承諾", "政治支持與議會微幅下滑", { politicalSupport: -4, parliamentSatisfaction: -3 }]),

  ev("culture", "cul_national_day_ceremony", "百年國慶慶典籌備爭議",
    "即將到來的百年國慶典禮預算龐大，文化界與議會針對節目安排與經費分配產生激烈爭論。", 8,
    ["追加藝術專案預算廣納提案", "政治支持與議會回升，國庫大量支出", { politicalSupport: 8, parliamentSatisfaction: 6, money: -2000 }],
    ["取消民間節目改為純軍事閱兵", "軍方大為滿意，但議會與政治支持下降", { militarySatisfaction: 12, parliamentSatisfaction: -10, politicalSupport: -8 }],
    ["削減爭議項目維持基本儀式", "政治支持與議會小幅下滑", { politicalSupport: -3, parliamentSatisfaction: -3 }]),
];
