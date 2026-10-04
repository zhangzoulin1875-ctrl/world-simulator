import { CheckCircle2, Lock } from "lucide-react";
import type { TechTreeDomainView, TechTreeNodeView } from "@workspace/api-client-react";

/**
 * 年代解鎖一覽(科技樹下線後取代樹狀視圖)。
 * 關鍵技術隨世界時代自動解鎖,沒有研發操作;這裡只負責讓玩家看懂
 * 「現在有什麼、之後何時會有什麼」。
 */
export function EraUnlockList({ domainView }: { domainView: TechTreeDomainView }) {
  const nodes = [...domainView.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  const unlockedCount = nodes.filter((n) => n.status === "researched").length;

  return (
    <div className="p-5" data-testid={`era-unlock-list-${domainView.domain}`}>
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="font-serif text-lg font-bold text-white">
          {domainView.domainLabel}關鍵技術
        </h3>
        <span className="text-xs text-white/50">
          已解鎖 {unlockedCount} / {nodes.length}
        </span>
      </div>
      <ul className="space-y-2.5">
        {nodes.map((n) => (
          <EraUnlockRow key={n.keySlug ?? n.id} node={n} />
        ))}
      </ul>
    </div>
  );
}

function EraUnlockRow({ node }: { node: TechTreeNodeView }) {
  const open = node.status === "researched";
  return (
    <li
      className={`rounded-lg border p-3.5 ${
        open
          ? "border-emerald-400/25 bg-emerald-950/20"
          : "border-white/10 bg-black/30 opacity-70"
      }`}
      data-testid={`era-unlock-${node.keySlug}`}
    >
      <div className="flex items-start gap-3">
        {open ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
        ) : (
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-white/40" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-serif text-base font-bold text-white">{node.name}</span>
            <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60">
              {node.eraLabel}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-white/60">{node.description}</p>
          {node.effects.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {node.effects.map((e, i) => (
                <span
                  key={i}
                  className="rounded bg-sky-900/40 px-1.5 py-0.5 text-[11px] text-sky-200"
                >
                  {e}
                </span>
              ))}
            </div>
          )}
          {!open && node.lockedReason && (
            <p className="mt-2 text-[11px] text-amber-300/80">{node.lockedReason}</p>
          )}
        </div>
      </div>
    </li>
  );
}
