import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Settings2, Loader2, Info } from "lucide-react";
import {
  useSetTechTreeAllocation,
  getGetTechTreeOverviewQueryKey,
} from "@workspace/api-client-react";
import type { TechTreeAllocation } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";

interface AllocationEditorProps {
  allocation: TechTreeAllocation;
  techGainPerTurn: number;
  stockTechPoints: number;
}

export function AllocationEditor({
  allocation,
  techGainPerTurn,
  stockTechPoints,
}: AllocationEditorProps) {
  const [social, setSocial] = useState(allocation.social);
  const [production, setProduction] = useState(allocation.production);
  const [military, setMilitary] = useState(allocation.military);
  const [isEditing, setIsEditing] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const setMutation = useSetTechTreeAllocation({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTechTreeOverviewQueryKey() });
        setIsEditing(false);
        toast({ title: "已儲存科研分配" });
      },
      onError: (err) => {
        toast({ title: "儲存失敗", description: apiErrorMessage(err), variant: "destructive" });
      }
    }
  });

  const total = social + production + military;
  const isValid = total === 100;
  const hasChanges = social !== allocation.social || production !== allocation.production || military !== allocation.military;

  const handleSave = () => {
    if (!isValid) return;
    setMutation.mutate({ data: { social, production, military } });
  };

  const handleCancel = () => {
    setSocial(allocation.social);
    setProduction(allocation.production);
    setMilitary(allocation.military);
    setIsEditing(false);
  };

  const previewSocial = Math.floor(techGainPerTurn * (social / 100));
  const previewProduction = Math.floor(techGainPerTurn * (production / 100));
  const previewMilitary = Math.floor(techGainPerTurn * (military / 100));

  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-5 backdrop-blur shadow-lg">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-sky-400" />
          <h3 className="font-serif text-base font-bold text-white">全國科研點數分配</h3>
        </div>
        <div className="text-right">
          <div className="text-xs text-white/50">每回合總產出</div>
          <div className="font-mono text-sm font-bold text-sky-300">
            {formatBigNumber(techGainPerTurn)}
          </div>
        </div>
      </div>

      <div
        className="mb-4 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2"
        data-testid="block-stock-tech-points"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-violet-200">庫存科技點數</span>
          <span
            className="font-mono text-sm font-bold text-violet-300"
            data-testid="text-stock-tech-points"
          >
            {formatBigNumber(stockTechPoints)}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-white/50">
          來自條約交換、贈禮等的庫存科技點，每回合會依上方分配比例自動投入研發；只扣實際被吸收的量，用不完的留在庫存下回合再投入。
        </p>
      </div>

      <div className="space-y-4">
        <AllocationSlider
          label="社會科技"
          colorClass="text-amber-300"
          bgClass="bg-amber-400"
          value={social}
          onChange={(v) => {
            if (isEditing) setSocial(v);
          }}
          previewPoints={previewSocial}
          isEditing={isEditing}
        />
        <AllocationSlider
          label="生產科技"
          colorClass="text-emerald-300"
          bgClass="bg-emerald-400"
          value={production}
          onChange={(v) => {
            if (isEditing) setProduction(v);
          }}
          previewPoints={previewProduction}
          isEditing={isEditing}
        />
        <AllocationSlider
          label="軍事科技"
          colorClass="text-red-300"
          bgClass="bg-red-400"
          value={military}
          onChange={(v) => {
            if (isEditing) setMilitary(v);
          }}
          previewPoints={previewMilitary}
          isEditing={isEditing}
        />

        {isEditing && (
          <div className={`mt-2 flex items-center gap-2 text-xs font-medium p-2 rounded ${isValid ? 'bg-sky-500/10 text-sky-200' : 'bg-red-500/10 text-red-300'}`}>
            <Info className="h-4 w-4 shrink-0" />
            <span>目前分配總和: {total}% {isValid ? '(符合要求)' : '(必須等於 100%)'}</span>
          </div>
        )}

        <div className="pt-2">
          {isEditing ? (
            <div className="flex gap-2">
              <button
                onClick={handleCancel}
                disabled={setMutation.isPending}
                className="flex-1 rounded border border-white/10 bg-transparent py-1.5 text-xs font-semibold text-white/60 transition hover:bg-white/5"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!isValid || !hasChanges || setMutation.isPending}
                className="flex flex-1 items-center justify-center gap-1 rounded bg-sky-600 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
              >
                {setMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                儲存分配
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="w-full rounded border border-sky-500/30 bg-sky-500/10 py-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20"
            >
              修改分配比例
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AllocationSlider({
  label,
  colorClass,
  bgClass,
  value,
  onChange,
  previewPoints,
  isEditing,
}: {
  label: string;
  colorClass: string;
  bgClass: string;
  value: number;
  onChange: (val: number) => void;
  previewPoints: number;
  isEditing: boolean;
}) {
  return (
    <div className="group">
      <div className="mb-1.5 flex justify-between text-xs">
        <span className={`font-semibold ${colorClass}`}>{label}</span>
        <div className="flex gap-3">
          <span className="font-mono text-white/80">{value}%</span>
          <span className="font-mono text-white/50 w-12 text-right">+{formatBigNumber(previewPoints)}</span>
        </div>
      </div>
      <div className="relative flex items-center">
        {isEditing ? (
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="w-full appearance-none bg-transparent accent-sky-400 focus:outline-none"
            style={{
              height: '6px',
              borderRadius: '9999px',
              background: `linear-gradient(to right, currentColor ${value}%, rgba(255,255,255,0.1) ${value}%)`,
              color: 'var(--color-primary)'
            }}
          />
        ) : (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className={`h-full ${bgClass} transition-all duration-300`} style={{ width: `${value}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
