import { Link } from "wouter";
import { Building2, Hammer, X } from "lucide-react";
import type { AvailableBuilding } from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";

/**
 * 建造介面：列出已由生產科技解鎖的建築，顯示成本／維護費／加成，
 * 金錢不足或未解鎖時停用按鈕。無任何解鎖建築時提示先研發生產科技。
 */
export function BuildDialog({
  target,
  availableBuildings,
  money,
  pending,
  onBuild,
  onClose,
}: {
  target: { cityId: number; cityName: string } | null;
  availableBuildings: AvailableBuilding[];
  money: number;
  pending: boolean;
  onBuild: (buildingType: string) => void;
  onClose: () => void;
}) {
  if (!target) return null;
  const unlocked = availableBuildings.filter((b) => b.unlocked);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      data-testid="build-slot-dialog"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#1a1626]/95 p-5 text-white shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Hammer className="h-5 w-5 text-amber-300" />
            <h3 className="font-serif text-base font-bold">
              建造建築 · {target.cityName}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 bg-black/40 transition hover:bg-black/70"
            title="關閉"
            data-testid="button-close-build-dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {unlocked.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 bg-black/30 p-5 text-center">
            <Building2 className="mx-auto mb-2 h-8 w-8 text-white/30" />
            <p className="text-sm font-semibold text-white/80">
              尚無已解鎖建築
            </p>
            <p className="mt-1 text-xs leading-relaxed text-white/50">
              先於「科技 → 生產科技」研發解鎖建築的關鍵技術，即可在此建造。
            </p>
            <Link
              href="/game/military/tech"
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold transition hover:bg-white/20"
              data-testid="link-to-production-tech"
            >
              前往生產科技
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {unlocked.map((b) => {
              const affordable = money >= b.buildCost;
              return (
                <li
                  key={b.type}
                  className="rounded-xl border border-white/10 bg-black/30 p-3"
                  data-testid={`build-option-${b.type}`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-serif text-sm font-bold">
                      {b.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-amber-200">
                      {formatBigNumber(b.buildCost)} 金錢
                    </span>
                  </div>
                  <p className="mb-2 text-xs text-white/55">{b.description}</p>
                  <div className="mb-2 flex flex-wrap gap-1">
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-200 tabular-nums">
                      維護 {formatBigNumber(b.upkeep)} / 回合
                    </span>
                    {b.effects.map((e, i) => (
                      <span
                        key={i}
                        className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-200"
                      >
                        {e.label}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => onBuild(b.type)}
                    disabled={pending || !affordable}
                    className="w-full rounded-lg bg-amber-600/80 px-3 py-1.5 text-sm font-semibold transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`button-build-${b.type}`}
                  >
                    {pending ? "建造中…" : affordable ? "建造" : "金錢不足"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
