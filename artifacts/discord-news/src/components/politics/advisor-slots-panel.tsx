import { Link } from "wouter";
import { ArrowRight, Crown } from "lucide-react";

export function AdvisorSlotsPanel({ unlocked }: { unlocked: boolean }) {
  return (
    <Link
      href="/game/cabinet"
      className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-black/55 p-4 backdrop-blur transition hover:border-amber-300/50 hover:bg-black/70"
      data-testid="section-advisors"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
          <Crown className="h-5 w-5 text-amber-300" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-sm font-bold text-white/85">內閣</h2>
            {unlocked ? (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">
                社會科技已解鎖
              </span>
            ) : (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-white/55">
                古典時代起自動解鎖顧問席位
              </span>
            )}
          </div>
          <p className="text-[11px] text-white/55">
            任命內政大臣、元帥、外交官，授權代理國政事務
          </p>
        </div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-white/50" />
    </Link>
  );
}
