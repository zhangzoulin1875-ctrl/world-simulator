import React, { useEffect, useState } from "react";
import { Newspaper, Loader2, Hourglass } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { CHOICE_STYLE, shouldShowEventDialog, useDomesticEvents, useResolveDomesticEvent } from "@/lib/domesticEvents";
import { useAutopilot } from "@/lib/autopilot";

/**
 * 新手教學(歡迎彈窗 / 互動導覽)進行中時,事件彈窗要先等。
 * 原因:兩個 modal 同時開會讓 Radix 鎖住頁面(body pointer-events: none),
 * 事件彈窗雖然畫在上面,按鈕卻點不到。教學由別的元件管理、狀態不外露,
 * 這裡直接觀察 DOM,等教學結束才顯示事件,不改動教學程式碼。
 */
const TUTORIAL_SELECTOR = '[data-testid="dialog-welcome"], [data-testid="tour-overlay"]';
function useTutorialActive(): boolean {
  const [active, setActive] = useState(() => typeof document !== "undefined" && document.querySelector(TUTORIAL_SELECTOR) !== null);
  useEffect(() => {
    const check = () => setActive(document.querySelector(TUTORIAL_SELECTOR) !== null);
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return active;
}

/**
 * 國內隨機事件:全遊戲共用的強制彈窗。
 * - 有待處理事件就一定跳出來,不能點外面或按 Esc 關掉(事件是「強制改變進程」);
 * - 沒登入、沒有國家時 API 會回錯誤,useDomesticEvents 不重試,畫面就當作沒有事件;
 * - 處理完先顯示結果,玩家按「知道了」才關閉。
 */
export function DomesticEventGate({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  // 只在遊戲頁(/game 開頭)啟用:新聞網站與後台頁不查詢、不彈窗
  const inGame = location === "/game" || location.startsWith("/game/");
  const { data, refetch } = useDomesticEvents(inGame);
  const resolve = useResolveDomesticEvent();
  const { toast } = useToast();
  const [result, setResult] = useState<{ title: string; outcome: string; civilWar: boolean } | null>(null);

  const pending = inGame ? (data?.pending ?? null) : null;
  const tutorialActive = useTutorialActive();
  // AI 託管中:操作已鎖定,不彈強制選擇(否則玩家得先解除託管才能選、
  // 但彈窗又蓋住「解除託管」,形成死結)。事件到期會自動採取「拖延」,不會懸著。
  const { isLocked: autopilotLocked } = useAutopilot({ enabled: inGame });
  const open = shouldShowEventDialog({
    inGame,
    tutorialActive,
    autopilotLocked,
    hasPending: pending !== null,
    hasResult: result !== null,
  });

  const choose = async (choiceId: string) => {
    if (!pending || resolve.isPending) return;
    try {
      const r = await resolve.mutateAsync({ id: pending.id, choiceId });
      setResult({ title: pending.title, outcome: r.outcome, civilWar: r.civilWar });
    } catch (err: any) {
      toast({ title: "處理失敗", description: err?.message || "請稍後再試", variant: "destructive" });
      // 可能是事件已被處理(例如雙開分頁或逾時自動處理):重抓,讓畫面回到最新狀態
      refetch();
    }
  };

  return (
    <>
      {children}
      {open && <div className="fixed inset-0 z-[190] bg-black/80" aria-hidden data-testid="event-backdrop" />}
      <Dialog open={open} onOpenChange={() => { /* 強制:不允許用點外面或 Esc 關閉 */ }}>
        <DialogContent
          className="z-[200] max-w-lg border-amber-300/30 bg-zinc-950 text-zinc-100 [&>button.absolute]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          data-testid="dialog-domestic-event"
        >
          {result ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-serif text-lg">
                  <Newspaper className="h-5 w-5 text-amber-300" />
                  {result.title}
                </DialogTitle>
                <DialogDescription className="pt-2 text-sm leading-relaxed text-zinc-300" data-testid="text-event-outcome">
                  {result.outcome}
                </DialogDescription>
              </DialogHeader>
              {result.civilWar && (
                <p className="rounded-md border border-red-400/40 bg-red-500/15 px-3 py-2 text-sm text-red-200">
                  鎮壓失控,國內已爆發內戰,請到軍事與議會頁面查看局勢。
                </p>
              )}
              <Button onClick={() => setResult(null)} data-testid="button-event-dismiss">知道了</Button>
            </>
          ) : pending ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-serif text-lg">
                  <Newspaper className="h-5 w-5 text-amber-300" />
                  {pending.title}
                </DialogTitle>
                <DialogDescription className="pt-2 text-sm leading-relaxed text-zinc-300" data-testid="text-event-body">
                  {pending.body}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {pending.choices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => choose(c.id)}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${CHOICE_STYLE[c.id] ?? CHOICE_STYLE["delay"]}`}
                    data-testid={`button-event-choice-${c.id}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {resolve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {c.label}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-400">{c.hint}</div>
                  </button>
                ))}
              </div>
              <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Hourglass className="h-3 w-3" />
                {pending.turnsLeft > 0
                  ? `再過 ${pending.turnsLeft} 個回合未處理,將自動採取「拖延」`
                  : "本回合結算時若仍未處理,將自動採取「拖延」"}
              </p>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
