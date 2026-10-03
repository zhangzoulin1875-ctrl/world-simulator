import { Trash2 } from "lucide-react";
import type { PoliticsEntry } from "@workspace/api-client-react";
import { STATUS_LABELS, modifierText } from "./shared";

export function EntryCard({
  entry,
  onRepeal,
  repealing,
}: {
  entry: PoliticsEntry;
  onRepeal: (id: number) => void;
  repealing: boolean;
}) {
  const active = entry.status === "active";
  const fading = entry.entryType === "reform" || entry.entryType === "event";
  const repealable =
    active && (entry.entryType === "policy" || entry.entryType === "tradition");

  return (
    <li
      className={`rounded-xl border p-3 ${
        active ? "border-white/20 bg-white/5" : "border-white/10 bg-black/30 opacity-70"
      }`}
      data-testid={`entry-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                entry.entryType === "policy"
                  ? "bg-sky-500/20 text-sky-300"
                  : entry.entryType === "tradition"
                    ? "bg-purple-500/20 text-purple-300"
                    : entry.entryType === "reform"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-rose-500/20 text-rose-300"
              }`}
            >
              {entry.entryTypeLabel}
            </span>
            {entry.directionLabel && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-white/70">
                {entry.directionLabel}
              </span>
            )}
            <span className="truncate text-sm font-bold">{entry.title}</span>
            {!active && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
                {STATUS_LABELS[entry.status] ?? entry.status}
              </span>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
            {entry.description}
          </p>
        </div>
        {repealable && (
          <button
            onClick={() => {
              if (window.confirm(`確定要廢除「${entry.title}」嗎？加減成將即刻失效。`)) {
                onRepeal(entry.id);
              }
            }}
            disabled={repealing}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-red-400/40 bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/30 disabled:opacity-50"
            data-testid={`button-repeal-${entry.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            廢除
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {entry.modifiers.map((m, i) => (
          <span
            key={i}
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
              m.value > 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
            }`}
          >
            {modifierText(m)}
          </span>
        ))}
        {active && fading && entry.remainingTurns != null && entry.durationTurns != null && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/60">
            剩餘 {entry.remainingTurns}/{entry.durationTurns} 回合（強度{" "}
            {Math.round(entry.strength * 100)}%）
          </span>
        )}
        {active && !fading && entry.remainingTurns != null && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/60">
            剩餘 {entry.remainingTurns} 回合
          </span>
        )}
        {active && entry.durationTurns == null && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/60">
            永久
          </span>
        )}
      </div>
    </li>
  );
}
