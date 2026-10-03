import React from "react";
import {
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Map,
  Swords,
  Handshake,
  Landmark,
  Coins,
  FlaskConical,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type OnboardingPhase = "welcome" | "tour" | null;

interface WelcomeCard {
  icon: React.ElementType;
  title: string;
  body: string[];
}

const WELCOME_CARDS: WelcomeCard[] = [
  {
    icon: Sparkles,
    title: "歡迎來到架空世界模擬器",
    body: [
      "在這個共享的世界裡，你將建立並經營一個國家：拓展版圖、發展科技、經營內政、縱橫外交，並在必要時兵戎相見。",
      "這份導覽會用一分鐘帶你認識基本玩法。隨時可以略過，之後也能從首頁的「遊戲百科」再次開啟。",
    ],
  },
  {
    icon: Map,
    title: "建國與世界地圖",
    body: [
      "以 Discord 登入後即可建國：在世界地圖挑一塊無人掌控的地區，或直接接手一個無主國家。",
      "世界由 202 個地區組成，你的人口、生產力與科技成長，都由你「掌控的地區」依比例即時計算。",
    ],
  },
  {
    icon: FlaskConical,
    title: "回合制與資源",
    body: [
      "遊戲以「回合制」推進，一回合從幾小時到一天不等，會自動結算科技點數、稅收、維護費與人口等變化，每回合會推進遊戲時間數年。",
      "科技點數用來研發科技與設計兵種；生產力用來建軍；金錢來自稅收，用於購買軍隊與支付開銷。",
    ],
  },
  {
    icon: Handshake,
    title: "外交、政治與經濟",
    body: [
      "外交可與他國私訊、締約（互不侵犯／同盟／軍事通行權／保障獨立）或宣戰。",
      "政治以農民、工人、貴族(資本家)、教士四大階級經營民心；經濟以稅率掌控收支。每個介面右上都有問號說明。",
    ],
  },
  {
    icon: Swords,
    title: "軍事與戰爭",
    body: [
      "在軍事介面招募軍隊、研發軍事科技、甚至用 AI 設計專屬兵種。",
      "對關係惡化的國家宣戰後，即可對相鄰地區發動戰役、編組軍團並下達每回合的作戰指令。",
    ],
  },
];

/**
 * 新手教學：首次進入遊戲時先跳「歡迎導覽彈窗」（多步驟說明卡），
 * 結束後可選「進入互動導覽」或「略過」。互動導覽會逐步指向首頁上的
 * 主要按鈕與數值。歡迎彈窗與互動導覽皆只在首次觸發（由父層以 phase 控制），
 * 並可從首頁百科再次開啟。
 */
export function GameOnboarding({
  phase,
  onPhaseChange,
  onFinish,
}: {
  phase: OnboardingPhase;
  onPhaseChange: (p: OnboardingPhase) => void;
  /** 玩家完成或略過整個流程時呼叫（父層據此標記首次已完成）。 */
  onFinish: () => void;
}) {
  return (
    <>
      <WelcomeDialog
        open={phase === "welcome"}
        onStartTour={() => onPhaseChange("tour")}
        onSkip={() => {
          onPhaseChange(null);
          onFinish();
        }}
      />
      {phase === "tour" && (
        <InteractiveTour
          onClose={() => {
            onPhaseChange(null);
            onFinish();
          }}
        />
      )}
    </>
  );
}

function WelcomeDialog({
  open,
  onStartTour,
  onSkip,
}: {
  open: boolean;
  onStartTour: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = React.useState(0);
  const isLast = step === WELCOME_CARDS.length - 1;
  const card = WELCOME_CARDS[step];
  const Icon = card.icon;

  // 每次重新開啟都從第一張卡開始。
  React.useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onSkip()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto border-white/15 bg-zinc-900 text-white sm:max-w-lg"
        data-testid="dialog-welcome"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-white">
            <GraduationCap className="h-5 w-5 text-amber-300" />
            新手教學
          </DialogTitle>
          <DialogDescription className="text-white/60">
            第 {step + 1} / {WELCOME_CARDS.length} 步
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-white/10 bg-white/5 p-5" data-testid="welcome-card">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
              <Icon className="h-6 w-6 text-amber-200" />
            </div>
            <h3 className="font-serif text-lg font-bold text-white">{card.title}</h3>
          </div>
          <div className="space-y-2 text-sm leading-relaxed text-white/85">
            {card.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>

        {/* 進度點 */}
        <div className="flex justify-center gap-1.5">
          {WELCOME_CARDS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-5 bg-amber-300" : "w-1.5 bg-white/25"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-white/50 transition hover:text-white/80"
            data-testid="button-welcome-skip"
          >
            略過
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm transition hover:bg-black/70"
                data-testid="button-welcome-prev"
              >
                <ChevronLeft className="h-4 w-4" />
                上一步
              </button>
            )}
            {isLast ? (
              <button
                type="button"
                onClick={onStartTour}
                className="flex items-center gap-1.5 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400"
                data-testid="button-welcome-start-tour"
              >
                <Sparkles className="h-4 w-4" />
                進入互動導覽
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="flex items-center gap-1 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400"
                data-testid="button-welcome-next"
              >
                下一步
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface TourStep {
  /** 依序嘗試的目標 data-testid（桌機／手機不同版時列多個候選）。 */
  targets: string[];
  icon: React.ElementType;
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    targets: ["header-nation"],
    icon: Sparkles,
    title: "你的國家",
    body: "左上角是你的國旗與國名，代表你在這個世界的身分。",
  },
  {
    targets: ["stats-bar"],
    icon: FlaskConical,
    title: "國家數值",
    body: "這排是你的即時國力：科技點數、生產力、人口、金錢，以及穩定度、暴動度、厭戰度與傷兵。",
  },
  {
    targets: ["stat-tech"],
    icon: FlaskConical,
    title: "科技點數",
    body: "點數每回合會自動成長（綠色數字是每回合的增量），用來研發科技與設計兵種。點擊可看來源明細。",
  },
  {
    targets: ["stat-money"],
    icon: Coins,
    title: "金錢",
    body: "金錢主要來自每回合稅收。點擊金錢可直接前往經濟頁調整財政。",
  },
  {
    targets: ["button-nav-地圖", "button-nav-m-地圖"],
    icon: Map,
    title: "六大介面入口",
    body: "地圖、軍事、經濟、科技、政治、外交都由這裡進入。每個介面右上角都有問號，教你怎麼玩。",
  },
  {
    targets: ["button-nav-軍事", "button-nav-m-軍事"],
    icon: Swords,
    title: "軍事",
    body: "招募軍隊、研發軍事科技、設計兵種，並在宣戰後發動戰役。",
  },
  {
    targets: ["button-nav-外交", "button-nav-m-外交"],
    icon: Handshake,
    title: "外交",
    body: "與他國私訊、締約或宣戰，關係分數會影響你能做的外交選擇。",
  },
  {
    targets: ["button-nav-政治", "button-nav-m-政治"],
    icon: Landmark,
    title: "政治",
    body: "以農民、工人、貴族(資本家)、教士四大階級經營民心，維持穩定度。",
  },
  {
    targets: ["button-controlled-regions"],
    icon: Map,
    title: "掌控地區",
    body: "你的國力由掌控的地區依比例即時計算，拓展版圖就是壯大國家。",
  },
  {
    targets: ["button-encyclopedia"],
    icon: GraduationCap,
    title: "遊戲百科",
    body: "忘記某個名詞或機制時，隨時點首頁這顆問號查閱，也能重新開啟本教學。",
  },
];

const TOOLTIP_WIDTH = 320;
const SPOTLIGHT_PAD = 8;

function findTarget(targets: string[]): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const t of targets) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${t}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

/**
 * 互動導覽：以聚光燈方式逐步指向首頁的目標元素，並在旁顯示說明卡。
 * 找不到目標時（例如某按鈕在目前版型隱藏），說明卡會置中顯示。
 */
function InteractiveTour({ onClose }: { onClose: () => void }) {
  const [i, setI] = React.useState(0);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const step = TOUR_STEPS[i];
  const isLast = i === TOUR_STEPS.length - 1;

  React.useLayoutEffect(() => {
    let cancelled = false;
    function measure() {
      if (cancelled) return;
      const el = findTarget(step.targets);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    }
    measure();
    // 等版面／捲動穩定後再量一次，並在互動中持續校正位置。
    const raf = requestAnimationFrame(measure);
    const interval = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(interval);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  const tip = computeTooltipPosition(rect);
  const Icon = step.icon;

  return (
    <div className="fixed inset-0 z-[80]" data-testid="tour-overlay">
      {/* 遮罩：有目標時用聚光燈挖洞，無目標時整片變暗 */}
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-amber-300"
          style={{
            left: rect.left - SPOTLIGHT_PAD,
            top: rect.top - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.72)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-black/72" />
      )}

      {/* 攔截點擊，避免導覽時誤觸底下的頁面 */}
      <div className="fixed inset-0" onClick={onClose} />

      {/* 說明卡 */}
      <div
        className="fixed w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-amber-300/40 bg-zinc-900 p-4 text-white shadow-2xl"
        style={{ left: tip.left, top: tip.top, width: TOOLTIP_WIDTH }}
        onClick={(e) => e.stopPropagation()}
        data-testid="tour-card"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2.5 top-2.5 rounded-full p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
          aria-label="結束導覽"
          data-testid="button-tour-close"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-2 flex items-center gap-2 pr-6">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
            <Icon className="h-4.5 w-4.5 text-amber-200" />
          </div>
          <h3 className="font-serif text-base font-bold text-white">{step.title}</h3>
        </div>
        <p className="text-sm leading-relaxed text-white/85">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs text-white/45" data-testid="text-tour-progress">
            {i + 1} / {TOUR_STEPS.length}
          </span>
          <div className="flex items-center gap-2">
            {i > 0 && (
              <button
                type="button"
                onClick={() => setI((v) => v - 1)}
                className="flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-3 py-1.5 text-sm transition hover:bg-black/70"
                data-testid="button-tour-prev"
              >
                <ChevronLeft className="h-4 w-4" />
                上一步
              </button>
            )}
            <button
              type="button"
              onClick={() => (isLast ? onClose() : setI((v) => v + 1))}
              className="flex items-center gap-1 rounded-lg bg-amber-500/90 px-4 py-1.5 text-sm font-bold text-black transition hover:bg-amber-400"
              data-testid="button-tour-next"
            >
              {isLast ? "完成" : "下一步"}
              {!isLast && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 依目標矩形決定說明卡位置：優先置於下方，空間不足改上方；找不到目標則置中。 */
function computeTooltipPosition(rect: DOMRect | null): { left: number; top: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const estHeight = 200;
  const margin = 12;

  if (!rect) {
    return {
      left: Math.max(margin, (vw - TOOLTIP_WIDTH) / 2),
      top: Math.max(margin, (vh - estHeight) / 2),
    };
  }

  // 水平：對齊目標中心並夾在視窗內
  let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
  left = Math.min(Math.max(margin, left), vw - TOOLTIP_WIDTH - margin);

  // 垂直：下方優先，否則放上方，再不行就夾住
  let top: number;
  if (rect.bottom + estHeight + margin < vh) {
    top = rect.bottom + margin;
  } else if (rect.top - estHeight - margin > 0) {
    top = rect.top - estHeight - margin;
  } else {
    top = Math.min(Math.max(margin, rect.bottom + margin), vh - estHeight - margin);
  }
  return { left, top };
}
