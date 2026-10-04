import React, { useState } from "react";
import { Loader2, ShieldOff, Swords, Shield, AlertTriangle, Handshake } from "lucide-react";
import { useListWarCampaigns, getListWarCampaignsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  useMercenaryOverview,
  useMercenaryActions,
  type MercenaryCompanyView,
  type MercenaryOverview,
} from "@/lib/mercenary";

const panel = "rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur-sm md:p-6";
const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary = `${btn} border-amber-300/60 bg-amber-500/25 text-amber-100 hover:bg-amber-500/40`;
const btnDanger = `${btn} border-red-400/50 bg-red-500/20 text-red-100 hover:bg-red-500/35`;
const btnGhost = `${btn} border-white/20 bg-black/40 text-white/80 hover:bg-black/60`;

const fmt = (n: number) => Math.round(n).toLocaleString("zh-TW");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "操作失敗");

/** 軍事頁的「軍事合約」分頁:解除武裝 → 簽約 → 派遣。 */
export function MercenaryTab() {
  const { data, isLoading, error } = useMercenaryOverview();

  if (isLoading) {
    return (
      <div className={`${panel} flex items-center justify-center p-12`}>
        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className={panel} data-testid="panel-mercenary-error">
        <p className="text-sm text-red-200">{errMsg(error)}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="panel-mercenary">
      {data.lastTerminationNote && !data.contract && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-500/15 p-3 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span data-testid="text-termination-note">{data.lastTerminationNote}</span>
        </div>
      )}
      {data.contract ? (
        <ActiveContract overview={data} />
      ) : data.disarmed ? (
        <CompanyList overview={data} />
      ) : (
        <DisarmPanel overview={data} />
      )}
    </div>
  );
}

function DisarmPanel({ overview }: { overview: MercenaryOverview }) {
  const { toast } = useToast();
  const { disarm } = useMercenaryActions();
  const blocked = overview.hasActiveCampaign;

  return (
    <div className={panel} data-testid="panel-disarm">
      <div className="mb-3 flex items-center gap-2">
        <ShieldOff className="h-5 w-5 text-amber-300" />
        <h2 className="font-serif text-lg font-bold">解除武裝</h2>
      </div>
      <p className="mb-2 text-sm leading-relaxed text-white/80">
        解散全部常備軍與訓練中的單位,<b className="text-amber-200">100% 退還</b>
        已投入的人口、生產力與原料。解除武裝後即可向傭兵公司簽約,以每回合租金取代龐大的維護費,特別適合國力較小的國家。
      </p>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-white/60">
        <li>有進行中的戰役時無法解除武裝。</li>
        <li>簽約期間不能招募或訓練新部隊;要重新建軍須先解約。</li>
        <li>傭兵不會陣亡,只有士氣會變化。</li>
      </ul>
      {blocked && (
        <p className="mb-3 text-sm text-red-200" data-testid="text-disarm-blocked">
          目前有進行中的戰役,請等戰役結束後再解除武裝。
        </p>
      )}
      <button
        className={btnDanger}
        disabled={blocked || disarm.isPending}
        data-testid="button-disarm"
        onClick={() => {
          if (!window.confirm("確定要解散全部軍隊嗎?資源會 100% 退還,但此操作無法復原。")) return;
          disarm.mutate(undefined, {
            onSuccess: (r) =>
              toast({
                title: "已解除武裝",
                description: `解散 ${fmt(r.disbandedUnits)} 名士兵,退還人口 ${fmt(r.refundedPopulation)}、生產力 ${fmt(r.refundedProduction)}。`,
              }),
            onError: (e) => toast({ title: "無法解除武裝", description: errMsg(e), variant: "destructive" }),
          });
        }}
      >
        {disarm.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        解除武裝
      </button>
    </div>
  );
}

function CompanyList({ overview }: { overview: MercenaryOverview }) {
  const { toast } = useToast();
  const { sign, restoreArmy } = useMercenaryActions();
  const busy = sign.isPending || restoreArmy.isPending;

  return (
    <>
      <div className={panel}>
        <div className="mb-1 flex items-center gap-2">
          <Handshake className="h-5 w-5 text-amber-300" />
          <h2 className="font-serif text-lg font-bold">選擇傭兵公司</h2>
        </div>
        <p className="text-xs text-white/60">
          一次只能簽一間,解約後可立刻換家。兵力與租金會隨你的國力與時代即時調整。
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {overview.companies.map((c) => (
          <CompanyCard
            key={c.id}
            company={c}
            disabled={busy}
            pending={sign.isPending && sign.variables === c.id}
            onSign={() =>
              sign.mutate(c.id, {
                onSuccess: () => toast({ title: "簽約成功", description: `已與「${c.name}」簽訂合約。` }),
                onError: (e) => toast({ title: "無法簽約", description: errMsg(e), variant: "destructive" }),
              })
            }
          />
        ))}
      </div>
      <div className={`${panel} flex flex-col gap-2 md:flex-row md:items-center md:justify-between`}>
        <p className="text-sm text-white/70">不想僱傭兵?可以恢復建軍,之後再自行招募部隊。</p>
        <button
          className={btnGhost}
          disabled={busy}
          data-testid="button-restore-army"
          onClick={() =>
            restoreArmy.mutate(undefined, {
              onSuccess: () => toast({ title: "已恢復建軍" }),
              onError: (e) => toast({ title: "無法恢復建軍", description: errMsg(e), variant: "destructive" }),
            })
          }
        >
          {restoreArmy.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          恢復建軍
        </button>
      </div>
    </>
  );
}

function CompanyCard({
  company: c,
  disabled,
  pending,
  onSign,
}: {
  company: MercenaryCompanyView;
  disabled: boolean;
  pending: boolean;
  onSign: () => void;
}) {
  return (
    <div className={`${panel} flex flex-col gap-3`} data-testid={`card-company-${c.id}`}>
      <div>
        <h3 className="font-serif text-base font-bold text-amber-100">{c.name}</h3>
        <p className="text-xs text-white/60">{c.blurb}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-white/55">兵力</dt>
        <dd className="text-right font-bold">{fmt(c.troops)}</dd>
        <dt className="text-white/55">攻擊 / 防禦</dt>
        <dd className="text-right font-bold">
          {fmt(c.attack)} / {fmt(c.defense)}
        </dd>
        <dt className="text-white/55">每回合租金</dt>
        <dd className="text-right font-bold text-amber-200">{fmt(c.rentPerTurn)}</dd>
        <dt className="text-white/55">戰役出動費</dt>
        <dd className="text-right font-bold">{fmt(c.deployFeePerTurn)} / 回合</dd>
      </dl>
      {c.smallNationBoost > 1.005 && (
        <p className="text-xs text-emerald-300">小國補償 ×{c.smallNationBoost.toFixed(2)}</p>
      )}
      <button className={`${btnPrimary} mt-auto`} disabled={disabled} onClick={onSign} data-testid={`button-sign-${c.id}`}>
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        簽約
      </button>
    </div>
  );
}

function ActiveContract({ overview }: { overview: MercenaryOverview }) {
  const { toast } = useToast();
  const { terminate, recall } = useMercenaryActions();
  const c = overview.contract!;
  const company = overview.companies.find((x) => x.id === c.companyId);

  return (
    <>
      <div className={panel} data-testid="panel-active-contract">
        <div className="mb-3 flex items-center gap-2">
          <Handshake className="h-5 w-5 text-amber-300" />
          <h2 className="font-serif text-lg font-bold">目前合約:{c.name}</h2>
        </div>
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
          <dt className="text-white/55">每回合租金</dt>
          <dd className="font-bold text-amber-200">{fmt(c.rentPerTurn)}</dd>
          <dt className="text-white/55">派遣中加收</dt>
          <dd className="font-bold">{fmt(c.deployFeePerTurn)}</dd>
          {company && (
            <>
              <dt className="text-white/55">兵力</dt>
              <dd className="font-bold">{fmt(company.troops)}</dd>
            </>
          )}
          <dt className="text-white/55">累計支出</dt>
          <dd className="font-bold">{fmt(overview.totals.rentPaid + overview.totals.deployPaid)}</dd>
        </dl>
        <p className="mb-4 text-xs text-white/55">
          租金併入每回合維護費;若付完其他維護費後資金不足,合約會自動終止。簽約期間不能招募新部隊。
        </p>
        <div className="flex flex-wrap gap-2">
          {c.deployed && (
            <button
              className={btnGhost}
              disabled={recall.isPending}
              data-testid="button-recall"
              onClick={() =>
                recall.mutate(undefined, {
                  onSuccess: () => toast({ title: "已召回傭兵" }),
                  onError: (e) => toast({ title: "無法召回", description: errMsg(e), variant: "destructive" }),
                })
              }
            >
              {recall.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              召回
            </button>
          )}
          <button
            className={btnDanger}
            disabled={terminate.isPending}
            data-testid="button-terminate"
            onClick={() => {
              if (!window.confirm(`確定要與「${c.name}」解約嗎?派遣中的傭兵會一併撤回。`)) return;
              terminate.mutate(undefined, {
                onSuccess: () => toast({ title: "已解約" }),
                onError: (e) => toast({ title: "無法解約", description: errMsg(e), variant: "destructive" }),
              });
            }}
          >
            {terminate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            解約
          </button>
        </div>
      </div>
      <DeployPanel overview={overview} />
    </>
  );
}

const SLOTS = ["A", "B", "C"] as const;

function DeployPanel({ overview }: { overview: MercenaryOverview }) {
  const { toast } = useToast();
  const { deploy } = useMercenaryActions();
  const { data } = useListWarCampaigns({
    query: { queryKey: getListWarCampaignsQueryKey(), refetchInterval: 60_000 },
  });
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [slot, setSlot] = useState<(typeof SLOTS)[number]>("A");

  const deployed = overview.contract?.deployed ?? null;
  const active = (data?.campaigns ?? []).filter((x) => x.status === "active");
  const selected = active.find((x) => x.id === campaignId) ?? null;
  const mode = selected?.role === "attacker" ? "attack" : "defend";

  if (deployed) {
    return (
      <div className={panel} data-testid="panel-deployed">
        <div className="flex items-center gap-2">
          {deployed.mode === "attack" ? (
            <Swords className="h-5 w-5 text-red-300" />
          ) : (
            <Shield className="h-5 w-5 text-sky-300" />
          )}
          <h2 className="font-serif text-lg font-bold">派遣中</h2>
        </div>
        <p className="mt-2 text-sm text-white/75">
          已以{deployed.mode === "attack" ? "進攻" : "防守"}姿態派駐戰役 #{deployed.campaignId} 的 {deployed.slot} 欄位。
        </p>
      </div>
    );
  }

  return (
    <div className={panel} data-testid="panel-deploy">
      <div className="mb-3 flex items-center gap-2">
        <Swords className="h-5 w-5 text-amber-300" />
        <h2 className="font-serif text-lg font-bold">派遣傭兵</h2>
      </div>
      {active.length === 0 ? (
        <p className="text-sm text-white/55">目前沒有進行中的戰役可以派遣。</p>
      ) : (
        <div className="flex flex-col gap-3">
          <select
            className="rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-sm text-white"
            value={campaignId ?? ""}
            onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}
            data-testid="select-deploy-campaign"
          >
            <option value="">選擇戰役…</option>
            {active.map((x) => (
              <option key={x.id} value={x.id}>
                #{x.id} 對 {x.opponentName}({x.role === "attacker" ? "進攻" : "防守"}:{x.attackerRegionName} → {x.defenderRegionName})
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <span className="text-sm text-white/60">佔用欄位</span>
            {SLOTS.map((s) => (
              <button
                key={s}
                className={`${btn} ${slot === s ? "border-amber-300/60 bg-amber-500/25 text-amber-100" : "border-white/20 bg-black/40 text-white/70"}`}
                onClick={() => setSlot(s)}
                data-testid={`button-slot-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-xs text-white/50">
            {selected
              ? `將以「${mode === "attack" ? "進攻" : "防守"}」姿態派駐(依你在這場戰役的立場決定)。`
              : "選擇戰役後會自動決定進攻或防守。"}
            傭兵佔用一個軍團欄位,該欄位需為空。
          </p>
          <button
            className={btnPrimary}
            disabled={!selected || deploy.isPending}
            data-testid="button-deploy"
            onClick={() =>
              selected &&
              deploy.mutate(
                { campaignId: selected.id, slot, mode },
                {
                  onSuccess: () => toast({ title: "已派遣傭兵", description: `戰役 #${selected.id} 欄位 ${slot}` }),
                  onError: (e) => toast({ title: "無法派遣", description: errMsg(e), variant: "destructive" }),
                },
              )
            }
          >
            {deploy.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            派遣
          </button>
        </div>
      )}
    </div>
  );
}

/** 建軍頁頂端橫幅:簽約期間不能招募,引導玩家去「軍事合約」分頁解約。 */
export function ContractNotice({ onOpen }: { onOpen: () => void }) {
  const { data } = useMercenaryOverview();
  if (!data?.contract) return null;
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-amber-400/50 bg-amber-500/15 p-3 text-sm text-amber-100 md:flex-row md:items-center md:justify-between"
      data-testid="notice-mercenary-contract"
    >
      <span>
        目前與「{data.contract.name}」簽有合約,期間無法招募或訓練新部隊。要重新建軍,請先解約。
      </span>
      <button className={btnGhost} onClick={onOpen} data-testid="button-open-contracts">
        前往軍事合約
      </button>
    </div>
  );
}
