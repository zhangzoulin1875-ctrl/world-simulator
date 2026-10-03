import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Eye,
  Globe2,
  MapPin,
  Pencil,
  Siren,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  formatDateTime,
  kindLabel,
  stageLabel,
  targetStatsText,
  type AdminSuperEvent,
} from "./shared";

export function EventGroup({
  title,
  events,
  regionNameById,
  nationNameById,
  onEdit,
  onDelete,
  onView,
}: {
  title: string;
  events: AdminSuperEvent[];
  regionNameById: Map<number, string>;
  nationNameById: Map<string, string>;
  onEdit: (e: AdminSuperEvent) => void;
  onDelete: (e: AdminSuperEvent) => void;
  onView: (e: AdminSuperEvent) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-bold text-muted-foreground">
        {title}（{events.length}）
      </h2>
      <div className="space-y-2.5">
        {events.map((e) => (
          <div
            key={e.id}
            className="rounded-lg border bg-card p-4"
            data-testid={`admin-super-event-${e.id}`}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                  e.kind === "opportunity"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                    : "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300",
                )}
              >
                {e.kind === "opportunity" ? (
                  <Sparkles className="h-3 w-3" />
                ) : (
                  <Siren className="h-3 w-3" />
                )}
                {kindLabel(e.kind)}
              </span>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300">
                {stageLabel(e.stage)}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                  e.scope === "global"
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                )}
              >
                {e.scope === "global" ? (
                  <>
                    <Globe2 className="h-3 w-3" /> 全球
                  </>
                ) : e.scope === "targeted" ? (
                  <>
                    <MapPin className="h-3 w-3" /> 指定國家（{e.nationIds.length}）
                  </>
                ) : (
                  <>
                    <MapPin className="h-3 w-3" /> 區域（{e.regionIds.length}）
                  </>
                )}
              </span>
              {e.scope === "regional" && e.canSpread && (
                <span className="rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs text-orange-600 dark:text-orange-300">
                  可蔓延
                </span>
              )}
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                {e.category}
              </span>
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                {e.cause === "admin"
                  ? "管理員"
                  : e.cause === "player_decision"
                    ? "政治決策"
                    : "AI"}
              </span>
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                嚴重度 {e.severity} · 影響 {e.impactPct}%
              </span>
              {e.targetStats && e.targetStats.length > 0 && (
                <span className="rounded-full border border-indigo-500/40 px-2 py-0.5 text-xs text-indigo-600 dark:text-indigo-300">
                  目標：{targetStatsText(e.targetStats)}
                </span>
              )}
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  e.status === "active"
                    ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                    : "text-muted-foreground",
                )}
              >
                {e.status === "active" ? "進行中" : "已結束"}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                第 {e.turnsElapsed}
                {e.maxTurns ? ` / ${e.maxTurns}` : ""} 回合
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-bold">{e.title}</h3>
                <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                  {e.summary}
                </p>
                {e.scope === "regional" && e.regionIds.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    影響地區：
                    {e.regionIds
                      .map((id) => regionNameById.get(id) ?? `#${id}`)
                      .join("、")}
                  </p>
                )}
                {e.scope === "targeted" && e.nationIds.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    指定國家：
                    {e.nationIds
                      .map((id) => nationNameById.get(id) ?? "（未知國家）")
                      .join("、")}
                  </p>
                )}
                {e.grantedTechs.length > 0 && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-indigo-500 dark:text-indigo-300">
                    <Sparkles className="h-3 w-3" />
                    賦予科技：{e.grantedTechs.map((t) => t.name).join("、")}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  建立於 {formatDateTime(e.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onView(e)}
                  data-testid={`button-view-${e.id}`}
                >
                  <Eye className="mr-1 h-3.5 w-3.5" /> 應對
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(e)}
                  data-testid={`button-edit-${e.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDelete(e)}
                  data-testid={`button-delete-${e.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
