import React, { useState } from "react";
import { Newspaper, Loader2, Hourglass } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { CHOICE_STYLE, useDomesticEvents, useResolveDomesticEvent } from "@/lib/domesticEvents";

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
  const open = inGame && (pending !== null || result !== null);

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
      <Dialog open={open} onOpenChange={() => { /* 強制:不允許用點外面或 Esc 關閉 */ }}>
        <DialogContent
          className="max-w-lg border-amber-300/30 bg-zinc-950 text-zinc-100 [&>button]:hidden"
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
