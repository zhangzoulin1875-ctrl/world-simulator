import type { NpcTreatyHistoryEntry } from "@workspace/api-client-react";

// Task #90 — NPC 記得的近期提案（近 7 天最多 5 筆），與後端 NPC 判斷用的資料一致。
function npcHistoryWhen(updatedAt: string): string {
  const daysAgo = Math.max(
    0,
    Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000),
  );
  return daysAgo === 0 ? "今天" : `${daysAgo} 天前`;
}

export function NpcHistoryCard({ entry }: { entry: NpcTreatyHistoryEntry }) {
  const offerParts: string[] = [];
  if (entry.offerMoney > 0) offerParts.push(`金錢 ${entry.offerMoney}`);
  if (entry.offerTechPoints > 0)
    offerParts.push(`科技點數 ${entry.offerTechPoints}`);
  if (entry.offerRegionCount > 0)
    offerParts.push(`領土 ${entry.offerRegionCount} 區`);
  const duration =
    entry.durationDays == null ? "無期限" : `${entry.durationDays} 天`;
  return (
    <div
      className="rounded-lg bg-black/30 px-3 py-2 text-xs"
      data-testid={`npc-history-entry`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-white/45">{npcHistoryWhen(entry.updatedAt)}</span>
        <span className="font-semibold text-white/85">
          {entry.proposedByNpc ? "對方對案" : "我方提案"}【{entry.typeLabel}／
          {duration}】
        </span>
        <span className="text-white/60">
          附帶：{offerParts.length > 0 ? offerParts.join("、") : "無"}
        </span>
        <span className="rounded bg-purple-500/25 px-1.5 py-0.5 text-[10px] font-bold text-purple-200">
          {entry.statusLabel}
        </span>
      </div>
      {entry.responseNote && (
        <p className="mt-1 text-white/60">
          當時回覆：「{entry.responseNote}」
        </p>
      )}
    </div>
  );
}
