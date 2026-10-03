import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Save, Shield, Trash2 } from "lucide-react";
import {
  useUpdateWarCampaignLegions,
  getGetWarCampaignDetailQueryKey,
} from "@workspace/api-client-react";
import type {
  WarCampaignDetail,
  WarLegionViewSlot,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";

// ── 軍團配置 ──────────────────────────────────────────────────

type SlotKey = WarLegionViewSlot;
const SLOTS: SlotKey[] = ["A", "B", "C"];
const SLOT_LABELS: Record<SlotKey, string> = { A: "第一軍團", B: "第二軍團", C: "第三軍團" };

interface LegionDraft {
  enabled: boolean;
  garrisoningCity: boolean;
  units: { templateId: number; quantity: number }[];
}

function draftsFromDetail(detail: WarCampaignDetail): Record<SlotKey, LegionDraft> {
  const out: Record<SlotKey, LegionDraft> = {
    A: { enabled: false, garrisoningCity: false, units: [] },
    B: { enabled: false, garrisoningCity: false, units: [] },
    C: { enabled: false, garrisoningCity: false, units: [] },
  };
  for (const l of detail.myLegions) {
    out[l.slot] = {
      enabled: true,
      garrisoningCity: l.garrisoningCity,
      units: l.units.map((u) => ({ templateId: u.templateId, quantity: u.quantity })),
    };
  }
  return out;
}

// Task #587 — 與 lib/war.ts coupAdjustedMorale 同公式：penalty ≤ 0 原值返回，
// 否則扣減後夾 ≥0（純顯示，不落地）。
function coupAdjustedMorale(morale: number, penalty: number): number {
  if (penalty <= 0) return morale;
  return Math.max(0, morale - penalty);
}

export function LegionEditor({
  detail,
  disabled,
  coupMoralePenalty = 0,
}: {
  detail: WarCampaignDetail;
  disabled: boolean;
  coupMoralePenalty?: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<SlotKey, LegionDraft>>(() => draftsFromDetail(detail));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDrafts(draftsFromDetail(detail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  const nameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of detail.availableUnits) m.set(u.templateId, u.name);
    for (const l of detail.myLegions) for (const u of l.units) m.set(u.templateId, u.name);
    return m;
  }, [detail]);

  const woundedBySlotTemplate = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of detail.myLegions)
      for (const u of l.units) if (u.wounded > 0) m.set(`${l.slot}:${u.templateId}`, u.wounded);
    return m;
  }, [detail]);

  const saveMutation = useUpdateWarCampaignLegions({
    mutation: {
      onSuccess: () => {
        setDirty(false);
        toast({ title: "軍團配置已更新" });
        queryClient.invalidateQueries({ queryKey: getGetWarCampaignDetailQueryKey(detail.id) });
      },
      onError: (err) =>
        toast({ variant: "destructive", title: "軍團配置更新失敗", description: apiErrorMessage(err) }),
    },
  });

  const mutateDraft = (slot: SlotKey, fn: (d: LegionDraft) => LegionDraft) => {
    setDrafts((prev) => ({ ...prev, [slot]: fn(prev[slot]) }));
    setDirty(true);
  };

  const save = () => {
    const legions = SLOTS.filter((s) => drafts[s].enabled).map((s) => ({
      slot: s,
      garrisoningCity: drafts[s].garrisoningCity,
      units: drafts[s].units.filter((u) => u.quantity >= 0),
    }));
    saveMutation.mutate({ id: detail.id, data: { legions } });
  };

  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4 text-blue-300" />
          軍團配置
          <span className="text-xs font-normal text-white/45">（最多 3 個軍團，各 5 種兵種）</span>
        </div>
        {!disabled && (
          <button
            onClick={save}
            disabled={!dirty || saveMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-blue-400/50 bg-blue-600/25 px-3 py-1.5 text-xs font-bold text-blue-100 transition hover:bg-blue-600/40 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-save-legions"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            儲存配置
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {SLOTS.map((slot) => (
          <LegionSlotCard
            key={slot}
            slot={slot}
            draft={drafts[slot]}
            legion={detail.myLegions.find((l) => l.slot === slot) ?? null}
            nameById={nameById}
            woundedBySlotTemplate={woundedBySlotTemplate}
            availableUnits={detail.availableUnits}
            disabled={disabled}
            coupMoralePenalty={coupMoralePenalty}
            onChange={(fn) => mutateDraft(slot, fn)}
          />
        ))}
      </div>

      {/* 可用兵力 */}
      <div className="mt-4">
        <div className="mb-1.5 text-xs font-semibold text-white/60">全國可派遣兵力</div>
        {detail.availableUnits.length === 0 ? (
          <p className="text-xs text-white/45">
            目前沒有可派遣的軍隊，請先到「建造軍隊」分頁招募。
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.availableUnits.map((u) => (
              <span
                key={u.templateId}
                className="rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70"
                data-testid={`chip-available-${u.templateId}`}
              >
                {u.name}
                <span className="ml-1.5 font-mono text-emerald-200">{formatBigNumber(u.available)}</span>
                <span className="ml-1 text-white/40">
                  / 持有 {formatBigNumber(u.owned)}
                  {u.woundedPool > 0 ? `・傷兵池 ${formatBigNumber(u.woundedPool)}` : ""}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LegionSlotCard({
  slot,
  draft,
  legion,
  nameById,
  woundedBySlotTemplate,
  availableUnits,
  disabled,
  coupMoralePenalty,
  onChange,
}: {
  slot: SlotKey;
  draft: LegionDraft;
  legion: WarCampaignDetail["myLegions"][number] | null;
  nameById: Map<number, string>;
  woundedBySlotTemplate: Map<string, number>;
  availableUnits: WarCampaignDetail["availableUnits"];
  disabled: boolean;
  coupMoralePenalty: number;
  onChange: (fn: (d: LegionDraft) => LegionDraft) => void;
}) {
  const [addId, setAddId] = useState<number | "">("");
  const usedIds = new Set(draft.units.map((u) => u.templateId));
  const addable = availableUnits.filter((u) => !usedIds.has(u.templateId) && u.available > 0);

  if (!draft.enabled) {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed border-white/20 bg-white/[0.03] p-4">
        {disabled ? (
          <span className="text-xs text-white/40">未編組</span>
        ) : (
          <button
            onClick={() => onChange((d) => ({ ...d, enabled: true }))}
            className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-bold text-white/75 transition hover:bg-white/20"
            data-testid={`button-enable-legion-${slot}`}
          >
            <Plus className="h-3.5 w-3.5" />
            編組{SLOT_LABELS[slot]}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/15 bg-white/[0.04] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-bold text-white/85">{SLOT_LABELS[slot]}</div>
        <div className="flex items-center gap-2">
          {legion && (
            <span className="text-xs text-white/50">
              士氣{" "}
              {coupMoralePenalty > 0 ? (
                <span
                  className="font-mono text-red-300"
                  title={`名目士氣 ${legion.morale}，政變懲罰 −${coupMoralePenalty}`}
                  data-testid={`text-effective-morale-${slot}`}
                >
                  {coupAdjustedMorale(legion.morale, coupMoralePenalty)}
                  <span className="ml-0.5 font-sans text-[10px] text-red-300/80">
                    （含政變 −{coupMoralePenalty}）
                  </span>
                </span>
              ) : (
                <span className="font-mono text-white/80">{legion.morale}</span>
              )}
              ・補給 <span className="font-mono text-white/80">{legion.supply}</span>
            </span>
          )}
          {!disabled && (
            <button
              onClick={() =>
                onChange(() => ({ enabled: false, garrisoningCity: false, units: [] }))
              }
              className="text-white/40 transition hover:text-red-300"
              title="解散此軍團配置（傷兵回傷兵池）"
              data-testid={`button-remove-legion-${slot}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <label className="mb-2 flex items-center gap-1.5 text-xs text-white/65">
        <input
          type="checkbox"
          checked={draft.garrisoningCity}
          disabled={disabled}
          onChange={(e) => onChange((d) => ({ ...d, garrisoningCity: e.target.checked }))}
          data-testid={`checkbox-garrison-${slot}`}
        />
        駐防城市（防守城市防線）
      </label>

      <div className="space-y-1.5">
        {draft.units.map((u, idx) => {
          const wounded = woundedBySlotTemplate.get(`${slot}:${u.templateId}`) ?? 0;
          return (
            <div key={u.templateId} className="flex items-center gap-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-white/75">
                {nameById.get(u.templateId) ?? "未知兵種"}
                {wounded > 0 && (
                  <span className="ml-1 text-amber-300/80">傷 {formatBigNumber(wounded)}</span>
                )}
              </span>
              <input
                type="number"
                min={0}
                value={u.quantity}
                disabled={disabled}
                onChange={(e) => {
                  const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                  onChange((d) => {
                    const units = [...d.units];
                    units[idx] = { ...units[idx]!, quantity: v };
                    return { ...d, units };
                  });
                }}
                className="w-24 rounded border border-white/20 bg-black/40 px-2 py-1 text-right font-mono text-xs text-white outline-none focus:border-amber-300/60"
                data-testid={`input-legion-${slot}-unit-${u.templateId}`}
              />
              {!disabled && (
                <button
                  onClick={() =>
                    onChange((d) => ({
                      ...d,
                      units: d.units.filter((x) => x.templateId !== u.templateId),
                    }))
                  }
                  className="text-white/40 transition hover:text-red-300"
                  title="移出此兵種（該兵種前線傷兵回傷兵池）"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {draft.units.length === 0 && (
          <p className="text-xs text-white/40">尚未加入兵種</p>
        )}
      </div>

      {!disabled && draft.units.length < 5 && addable.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5">
          <select
            value={addId}
            onChange={(e) => setAddId(e.target.value === "" ? "" : Number(e.target.value))}
            className="min-w-0 flex-1 rounded border border-white/20 bg-black/40 px-2 py-1 text-xs text-white outline-none"
            data-testid={`select-add-unit-${slot}`}
          >
            <option value="">選擇兵種…</option>
            {addable.map((u) => (
              <option key={u.templateId} value={u.templateId}>
                {u.name}（可派 {formatBigNumber(u.available)}）
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (addId === "") return;
              onChange((d) => ({
                ...d,
                units: [...d.units, { templateId: addId, quantity: 0 }],
              }));
              setAddId("");
            }}
            disabled={addId === ""}
            className="flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2 py-1 text-xs text-white/75 transition hover:bg-white/20 disabled:opacity-40"
            data-testid={`button-add-unit-${slot}`}
          >
            <Plus className="h-3 w-3" />
            加入
          </button>
        </div>
      )}
    </div>
  );
}
