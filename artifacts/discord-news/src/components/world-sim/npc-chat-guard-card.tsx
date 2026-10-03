import { type FormEvent } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldAlert, X } from "lucide-react";
import {
  formatDateTime,
  type GuardEventEntry,
  type GuardPlayerSummaryEntry,
} from "./shared";

/** 動作類型 → zh-TW 標籤（與 api-server lib/npcChatActions.ts 的標籤一致）。 */
const ACTION_LABELS: Record<string, string> = {
  gift: "送禮",
  exchange: "交換",
  declare_war: "宣戰",
  initiate_campaign: "出兵",
  ceasefire: "停戰",
  propose_treaty: "締約",
  alliance: "結盟",
};

interface NpcChatGuardCardProps {
  guardLoading: boolean;
  guardError: string | null;
  guardEvents: GuardEventEntry[] | null;
  guardSummary: GuardPlayerSummaryEntry[] | null;
  filterName: string;
  onFilterNameChange: (name: string) => void;
  onApplyFilter: (name: string) => void;
}

export function NpcChatGuardCard({
  guardLoading,
  guardError,
  guardEvents,
  guardSummary,
  filterName,
  onFilterNameChange,
  onApplyFilter,
}: NpcChatGuardCardProps) {
  const activeFilter = filterName.trim().length > 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onApplyFilter(filterName);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" />
          玩家操縱 NPC 未遂紀錄
        </CardTitle>
        <CardDescription>
          玩家在與 NPC 對話中誘使其讓利（送禮／交換）但被反操縱守門擋下的紀錄，
          最新在上，保留最近 200 則。次數摘要與篩選皆僅統計最近保留的 200 則。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <Input
            value={filterName}
            onChange={(e) => onFilterNameChange(e.target.value)}
            placeholder="依玩家名稱篩選（子字串）…"
            maxLength={100}
            className="h-8 max-w-xs text-sm"
            data-testid="input-guard-filter"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={guardLoading}
            data-testid="button-guard-filter"
          >
            篩選
          </Button>
          {activeFilter && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={guardLoading}
              onClick={() => onApplyFilter("")}
              data-testid="button-guard-filter-clear"
            >
              <X className="mr-1 h-3 w-3" />
              清除
            </Button>
          )}
        </form>

        {guardSummary && guardSummary.length > 0 && (
          <div data-testid="list-guard-summary">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              每玩家嘗試次數（最近 200 則內，點擊可篩選）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {guardSummary.map((s, i) => (
                <button
                  key={s.playerNationId ?? `deleted-${i}`}
                  type="button"
                  onClick={() => onApplyFilter(s.playerName)}
                  disabled={guardLoading}
                  className="focus-visible:ring-ring rounded-full focus-visible:outline-none focus-visible:ring-1"
                  data-testid={`chip-guard-summary-${i}`}
                >
                  <Badge
                    variant={
                      filterName.trim() === s.playerName
                        ? "default"
                        : "outline"
                    }
                    className="cursor-pointer"
                  >
                    {s.playerName} × {s.count}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        )}

        {guardLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入操縱嘗試紀錄中…
          </div>
        ) : guardError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {guardError}
          </p>
        ) : !guardEvents || guardEvents.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {activeFilter
              ? "此篩選條件下沒有任何被擋下的操縱嘗試。"
              : "尚無任何被擋下的操縱嘗試。"}
          </p>
        ) : (
          <ul className="space-y-3" data-testid="list-guard-events">
            {guardEvents.map((e) => (
              <li key={e.id} className="rounded-lg border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant="destructive">
                    {ACTION_LABELS[e.actionType] ?? e.actionType}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(e.createdAt)}
                  </span>
                </div>
                <p className="text-sm font-medium">
                  {e.playerName} → {e.npcName}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {e.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
