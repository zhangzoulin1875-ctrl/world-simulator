import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Flag, GitBranch, Lock, Map as MapIcon } from "lucide-react";
import {
  TRACK_LABEL, TRACK_STYLE, layoutTree,
  type FocusCard, type FocusView, type LaidEdge, type LaidNode, type TreeMode,
} from "@/lib/focus";

const TRACK_STROKE: Record<string, string> = {
  stable: "#6ee7b7", black: "#d4d4d8", red: "#f87171", reform: "#7dd3fc",
};

interface Props {
  view: FocusView;
  busy: boolean;
  onStart: (f: FocusCard) => void;
}

/** 政體路線樹:節點 = 政體(國策樹終點站),連線 = 轉型國策。兩種視角:以我為根 / 全景。 */
export function FocusTree({ view, busy, onStart }: Props) {
  const [mode, setMode] = useState<TreeMode>("rooted");
  const [picked, setPicked] = useState<string | null>(null);
  const layout = useMemo(() => layoutTree(view.tree, mode), [view.tree, mode]);
  const cardById = useMemo(() => new Map(view.focuses.map((f) => [f.id, f])), [view.focuses]);

  // 量測每個節點的位置,畫 SVG 連線
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [geo, setGeo] = useState<{ w: number; h: number; pos: Map<string, { x: number; y: number; w: number; h: number }> }>({ w: 0, h: 0, pos: new Map() });
  useLayoutEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const wb = wrap.getBoundingClientRect();
      const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
      nodeRefs.current.forEach((el, slug) => {
        const b = el.getBoundingClientRect();
        pos.set(slug, { x: b.left - wb.left + wrap.scrollLeft, y: b.top - wb.top, w: b.width, h: b.height });
      });
      setGeo({ w: wrap.scrollWidth, h: wrap.scrollHeight, pos });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [layout]);

  const pickedNode = picked ? layout.nodes.find((n) => n.slug === picked) ?? null : null;
  // 選到的節點:列出「走到它」的轉型國策(從目前政體出發的那條)
  const incoming = pickedNode
    ? layout.edges.filter((e) => e.to === pickedNode.slug && e.from === view.tree.currentGovernment)
    : [];

  const nodeStyle = (n: LaidNode) => {
    if (n.isCurrent) return "border-amber-300 bg-amber-500/25 text-amber-50 shadow-[0_0_0_1px_rgba(252,211,77,.6)]";
    if (mode === "rooted" && n.depth === 1) return "border-white/40 bg-black/55 text-white";
    if (mode === "rooted" && n.depth === 2) return "border-dashed border-white/20 bg-black/30 text-white/60";
    return "border-white/20 bg-black/40 text-white/85";
  };

  const path = (e: LaidEdge): string | null => {
    const a = geo.pos.get(e.from), b = geo.pos.get(e.to);
    if (!a || !b) return null;
    if (e.back) {
      // 回邊:從節點下緣繞出去再回到目標下緣,避免穿過其他節點
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y + b.h;
      const dip = Math.max(y1, y2) + 18;
      return `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`;
    }
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  };

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3" data-testid="focus-tree">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-bold text-amber-200"><GitBranch className="h-3.5 w-3.5" />政體路線</h3>
        <div className="flex overflow-hidden rounded-md border border-white/20 text-[11px]" role="tablist">
          {([["rooted", "以我為根", GitBranch], ["full", "全景", MapIcon]] as const).map(([m, label, Icon]) => (
            <button
              key={m} type="button" role="tab" aria-selected={mode === m}
              onClick={() => { setMode(m); setPicked(null); }}
              className={`flex items-center gap-1 px-2.5 py-1 ${mode === m ? "bg-amber-500/25 text-amber-100" : "bg-black/30 text-white/70 hover:bg-white/10"}`}
              data-testid={`tree-mode-${m}`}
            >
              <Icon className="h-3 w-3" />{label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-white/55" data-testid="tree-hint">
        {mode === "rooted"
          ? (view.tree.limited
            ? "實線是你這個國家抽到、現在就能走的路線(抽到後固定,不會重抽)。虛線是再往下一步的預覽:換政體後會以新政體為根重新抽,實際能走哪些還不確定。"
            : "目前無法確認你抽到的路線,先顯示所有出口。")
          : "所有政體與它們之間的轉型路線(只是地圖,你實際能走的以「以我為根」為準)。亮框是你目前的位置;虛線彎到下方的是往回走的路。"}
      </p>

      <div ref={wrapRef} className="relative overflow-x-auto pb-2" data-testid="tree-canvas">
        <svg className="pointer-events-none absolute left-0 top-0" width={geo.w} height={geo.h} aria-hidden>
          {layout.edges.map((e) => {
            const d = path(e);
            if (!d) return null;
            const faded = e.back || e.preview || (!e.walkable && mode === "rooted");
            return (
              <path
                key={`${e.from}>${e.to}`} d={d} fill="none" stroke={TRACK_STROKE[e.track] ?? "#fff"}
                strokeWidth={e.walkable ? 2.2 : 1.3} strokeOpacity={e.walkable ? 0.95 : faded ? 0.35 : 0.55}
                strokeDasharray={e.back || e.preview ? "4 4" : undefined}
                data-testid={`tree-edge-${e.from}-${e.to}`}
              />
            );
          })}
        </svg>
        <div className="relative flex min-w-max gap-10 px-1 py-1">
          {layout.cols.map((col, ci) => (
            <div key={ci} className="flex flex-col justify-center gap-2.5">
              <div className="text-center text-[10px] text-white/40">
                {mode === "rooted" ? ["現在", "一步可達", "再一步(預覽)"][ci] : ci === 0 ? "建國起點" : `第 ${ci} 層`}
              </div>
              {col.map((n) => (
                <button
                  key={n.slug} type="button"
                  ref={(el) => { if (el) nodeRefs.current.set(n.slug, el); else nodeRefs.current.delete(n.slug); }}
                  onClick={() => setPicked(picked === n.slug ? null : n.slug)}
                  className={`w-28 rounded-lg border px-2 py-1.5 text-center text-xs font-bold transition ${nodeStyle(n)} ${picked === n.slug ? "ring-2 ring-sky-300/70" : ""}`}
                  data-testid={`tree-node-${n.slug}`} data-current={n.isCurrent}
                >
                  {n.label}
                  {n.isCurrent && <div className="text-[10px] font-normal text-amber-100/80">目前</div>}
                  {!n.isCurrent && n.isFounding && mode === "full" && <div className="text-[10px] font-normal text-white/50">可建國</div>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {pickedNode && (
        <div className="mt-2 rounded-lg border border-white/15 bg-black/40 p-2.5" data-testid="tree-detail">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-bold"><Flag className="h-3.5 w-3.5 text-sky-200" />{pickedNode.label}</div>
          {pickedNode.isCurrent ? (
            <p className="text-[11px] text-white/65">這是你現在的政體。</p>
          ) : incoming.length === 0 ? (
            <p className="text-[11px] text-white/65" data-testid="tree-detail-none">
              {view.tree.nodes.find((n) => n.slug === pickedNode.slug)?.depth === 2
                ? "從你現在的政體還不能直接走到這裡,需要先轉到中間的政體。"
                : "從你現在的政體沒有通往這裡的路線。"}
            </p>
          ) : incoming.map((e) => {
            const card = cardById.get(e.focusId);
            return (
              <div key={e.focusId} className="mt-1.5 rounded border border-white/10 bg-black/30 p-2" data-testid={`tree-step-${e.focusId}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className={`mr-1.5 rounded border px-1.5 py-0.5 text-[10px] font-bold ${TRACK_STYLE[e.track]}`}>{TRACK_LABEL[e.track]}</span>
                    <span className="text-xs font-bold">{card?.title ?? e.focusId}</span>
                    {card && <div className="mt-0.5 text-[11px] text-white/60">{card.cost} 點 · {card.turns} 回合</div>}
                  </div>
                  {card?.status === "available" && (
                    <button
                      type="button" disabled={busy} onClick={() => onStart(card)}
                      className="shrink-0 rounded-md border border-amber-300/50 bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
                      data-testid={`tree-start-${e.focusId}`}
                    >推行</button>
                  )}
                  {card?.status === "active" && <span className="text-[10px] text-amber-200">進行中</span>}
                </div>
                {card?.status === "locked" && card.lockedReason && (
                  <div className="mt-1 flex items-start gap-1 text-[11px] text-white/70"><Lock className="mt-0.5 h-3 w-3 shrink-0" />{card.lockedReason}</div>
                )}
                {!card && <div className="mt-1 text-[11px] text-white/55">這條路線這次沒抽到,走不了。</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
