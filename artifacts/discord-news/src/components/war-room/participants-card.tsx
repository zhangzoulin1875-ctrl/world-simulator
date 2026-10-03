import { Users } from "lucide-react";
import type {
  WarCampaignDetail,
  WarCampaignParticipantView,
} from "@workspace/api-client-react";

// ── Task #453 — 參戰國列表卡（分邊顯示，含晚加入者） ──────────

function SideColumn({
  title,
  accent,
  rows,
}: {
  title: string;
  accent: string;
  rows: WarCampaignParticipantView[];
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className={`mb-2 text-xs font-bold ${accent}`}>{title}</div>
      <ul className="space-y-1.5">
        {rows.map((p) => (
          <li
            key={p.nationId}
            className="flex flex-wrap items-center gap-1.5 text-sm"
            data-testid={`participant-${p.nationId}`}
          >
            <span className={p.isMe ? "font-bold text-amber-200" : "text-white/85"}>
              {p.nationName}
            </span>
            {p.isLead ? (
              <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold text-white/75">
                主帥
              </span>
            ) : (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">
                參戰
              </span>
            )}
            {p.isNpc ? (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/55">
                NPC
              </span>
            ) : null}
            {p.isMe ? (
              <span className="rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">
                我方
              </span>
            ) : null}
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="text-xs text-white/45">（無）</li>
        ) : null}
      </ul>
    </div>
  );
}

export function ParticipantsCard({ detail }: { detail: WarCampaignDetail }) {
  const participants = detail.participants ?? [];
  if (participants.length <= 2) return null;
  const attackers = participants.filter((p) => p.side === "attacker");
  const defenders = participants.filter((p) => p.side === "defender");
  return (
    <div
      className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid="card-participants"
    >
      <div className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4 text-white/70" />
        <h2 className="font-serif text-base font-bold">參戰國</h2>
        <span className="text-xs text-white/50">共 {participants.length} 國</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <SideColumn title="進攻方" accent="text-red-300" rows={attackers} />
        <SideColumn title="防守方" accent="text-blue-300" rows={defenders} />
      </div>
    </div>
  );
}
