import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ScrollText, Sparkles, Star, UserPlus } from "lucide-react";
import {
  useListGenerals,
  useDrawGeneral,
  useRecruitGeneral,
  useDismissGeneral,
  useUpgradeGeneral,
  useAssignGeneral,
  useUnassignGeneral,
  getListGeneralsQueryKey,
} from "@workspace/api-client-react";
import type { General } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 品級 → 顯示星星。 */
function GradeStars({ grade }: { grade: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`品級 ${grade}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={
            i < grade
              ? "h-3.5 w-3.5 fill-yellow-400 text-yellow-400"
              : "h-3.5 w-3.5 text-white/20"
          }
        />
      ))}
    </span>
  );
}

/** 戰力乘數顯示（+攻 % / +防 %）。 */
function CombatMods({ general }: { general: General }) {
  const off = Math.round((general.combatMods.offenseMult - 1) * 100);
  const def = Math.round((general.combatMods.defenseMult - 1) * 100);
  return (
    <span className="inline-flex items-center gap-2 text-xs font-bold tabular-nums">
      <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-200">
        攻 +{off}%
      </span>
      <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-blue-200">
        防 +{def}%
      </span>
    </span>
  );
}

/** 技能列表（含品級解鎖狀態）。 */
function SkillList({ general }: { general: General }) {
  if (general.skills.length === 0) return null;
  return (
    <ul className="space-y-1">
      {general.skills.map((skill) => {
        const unlocked = skill.unlockGrade <= general.grade;
        return (
          <li
            key={skill.name}
            className={`rounded border px-2 py-1 text-xs ${
              unlocked
                ? "border-white/15 bg-white/5 text-white/80"
                : "border-white/10 bg-black/30 text-white/40"
            }`}
          >
            <span className="font-bold">
              {unlocked ? skill.name : `${skill.name}（品級 ${skill.unlockGrade} 解鎖）`}
            </span>
            <span className="ml-1 text-white/50">· {skill.description}</span>
            {unlocked && (
              <span className="ml-1 text-emerald-300">
                {skill.effect === "defense"
                  ? `防+${skill.bonusPct}%`
                  : skill.effect === "offense"
                    ? `攻+${skill.bonusPct}%`
                    : `攻防+${skill.bonusPct}%`}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** 武將分頁：抽取 / 招募 / 遣返 / 升階 / 指派。 */
export function GeneralsTab() {
  const { data, isLoading } = useListGenerals({
    query: {
      queryKey: getListGeneralsQueryKey(),
      // 有「生成中」候選時加快輪詢（背景 AI 完成後盡快讓玩家看到結果）。
      refetchInterval: (query) =>
        query.state.data?.generals.some((g) => g.status === "generating")
          ? 4_000
          : 60_000,
    },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [assignPick, setAssignPick] = useState<Record<number, string>>({});
  const [confirmDismiss, setConfirmDismiss] = useState<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListGeneralsQueryKey() });

  const onErr = (title: string) => (err: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(err) });

  const drawMutation = useDrawGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        if (res.general.status === "generating") {
          toast({
            title: "招賢納士：武將正在幕後生成中！",
            description: `花費 金 ${fmt(res.spent.money)} ／ 生產力 ${fmt(
              res.spent.production,
            )}。生成期間可以離開此頁，完成後會直接出現在候選區。`,
          });
        } else {
          toast({
            title: `招賢納士：${res.general.name}（${res.general.title}）前來投效！`,
            description: `花費 金 ${fmt(res.spent.money)} ／ 生產力 ${fmt(
              res.spent.production,
            )}。候選中，請選擇招募或遣返。`,
          });
        }
      },
      onError: onErr("抽取失敗"),
    },
  });

  const recruitMutation = useRecruitGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({ title: `${res.general.name} 已入帳下，聽候調遣。` });
      },
      onError: onErr("招募失敗"),
    },
  });

  const dismissMutation = useDismissGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({ title: `${res.general.name} 已遣返，資源不予退還。` });
      },
      onError: onErr("遣返失敗"),
    },
  });

  const upgradeMutation = useUpgradeGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        if (res.success) {
          toast({
            title: `${res.general.name} 晉升成功！`,
            description: res.general.upgradeNarrative ?? undefined,
          });
        } else {
          toast({
            variant: "destructive",
            title: "升階失敗",
            description: `成功率 ${res.successPct}% 未中；花費不退還。`,
          });
        }
      },
      onError: onErr("升階失敗"),
    },
  });

  const assignMutation = useAssignGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({ title: `${res.general.name} 已坐鎮軍團。` });
      },
      onError: onErr("指派失敗"),
    },
  });

  const unassignMutation = useUnassignGeneral({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({ title: `${res.general.name} 已解除指揮，回到帳下。` });
      },
      onError: onErr("解除指派失敗"),
    },
  });

  const busy =
    drawMutation.isPending ||
    recruitMutation.isPending ||
    dismissMutation.isPending ||
    upgradeMutation.isPending ||
    assignMutation.isPending ||
    unassignMutation.isPending;

  const generals = data?.generals ?? [];
  const quota = data?.quota;
  const costs = data?.costs;
  const options = data?.assignmentOptions ?? [];

  const candidates = useMemo(
    () => generals.filter((g) => g.status === "candidate" || g.status === "generating"),
    [generals],
  );
  const recruited = useMemo(
    () => generals.filter((g) => g.status === "recruited"),
    [generals],
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur">
        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="panel-generals">
      {/* 頂部：配額 + 抽取 */}
      <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1">
            <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-white/90">
              <ScrollText className="h-5 w-5" /> 招賢榜
            </h2>
            <p className="mt-1 text-xs text-white/50">
              每回合可抽取一名武將（5% 國庫 + 5% 可用生產力）；在營上限{" "}
              {quota?.cap ?? 8} 名，候選不佔名額。
              {costs && (
                <>
                  {" "}
                  本次抽取成本：金 {fmt(costs.drawMoney)} ／ 生產力{" "}
                  {fmt(costs.drawProduction)}。
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold tabular-nums text-white/70">
              在營 {quota?.recruited ?? 0}/{quota?.cap ?? 8} · 候選{" "}
              {quota?.candidates ?? 0}
            </span>
            <Button
              data-testid="button-general-draw"
              disabled={busy || (quota?.drawnThisTurn ?? false)}
              onClick={() => drawMutation.mutate()}
              className="gap-1 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Sparkles className="h-4 w-4" />
              {quota?.drawnThisTurn ? "本回合已抽取" : "抽取武將"}
            </Button>
          </div>
        </div>
      </div>

      {/* 候選區 */}
      {candidates.length > 0 && (
        <section>
          <h3 className="mb-2 font-serif text-base font-bold text-white/80">
            候選武將（招募或遣返；遣返不退資源）
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {candidates.map((g) => (
              <GeneralCard key={g.id} general={g}>
                <div className="flex gap-2">
                  <Button
                    data-testid={`button-general-recruit-${g.id}`}
                    size="sm"
                    disabled={busy || g.status === "generating"}
                    title={g.status === "generating" ? "武將仍在生成中" : undefined}
                    onClick={() => recruitMutation.mutate({ id: g.id })}
                    className="gap-1 bg-emerald-700 text-white hover:bg-emerald-600"
                  >
                    <UserPlus className="h-3.5 w-3.5" /> 招募
                  </Button>
                  <Button
                    data-testid={`button-general-dismiss-${g.id}`}
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setConfirmDismiss(g.id)}
                  >
                    遣返
                  </Button>
                  {confirmDismiss === g.id && (
                    <span className="flex items-center gap-2 text-xs text-white/60">
                      確定？
                      <Button
                        data-testid={`button-general-dismiss-confirm-${g.id}`}
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setConfirmDismiss(null);
                          dismissMutation.mutate({ id: g.id });
                        }}
                      >
                        確定遣返
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDismiss(null)}>
                        取消
                      </Button>
                    </span>
                  )}
                </div>
              </GeneralCard>
            ))}
          </div>
        </section>
      )}

      {/* 在營武將 */}
      <section>
        <h3 className="mb-2 font-serif text-base font-bold text-white/80">
          在營武將
        </h3>
        {recruited.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-black/40 p-8 text-center text-sm text-white/50">
            尚無在營武將。抽取後從候選招募即可。
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {recruited.map((g) => {
              const freeOptions = options.filter(
                (o) => o.assignedGeneralId == null,
              );
              const pick = assignPick[g.id] ?? "";
              return (
                <GeneralCard key={g.id} general={g}>
                  <div className="flex flex-wrap items-center gap-2">
                    {g.assignedLegionId != null ? (
                      <>
                        <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-200">
                          坐鎮軍團 #{g.assignedLegionId}
                        </span>
                        <Button
                          data-testid={`button-general-unassign-${g.id}`}
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => unassignMutation.mutate({ id: g.id })}
                        >
                          解除指揮
                        </Button>
                      </>
                    ) : (
                      <>
                        <Select
                          value={pick || undefined}
                          onValueChange={(v) =>
                            setAssignPick((s) => ({ ...s, [g.id]: v }))
                          }
                        >
                          <SelectTrigger className="h-8 w-44 text-xs" data-testid={`select-general-assign-${g.id}`}>
                            <SelectValue placeholder="選擇軍團" />
                          </SelectTrigger>
                          <SelectContent>
                            {freeOptions.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-white/50">
                                沒有可坐鎮的軍團（無戰役或已滿）
                              </div>
                            ) : (
                              freeOptions.map((o) => (
                                <SelectItem key={o.legionId} value={String(o.legionId)}>
                                  戰役 #{o.campaignId} · {o.slot} 軍團
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    <Button
                      data-testid={`button-general-assign-${g.id}`}
                      size="sm"
                      variant="outline"
                      disabled={busy || !pick || g.assignedLegionId != null}
                      onClick={() => {
                        const legionId = Number(pick);
                        const opt = options.find((o) => o.legionId === legionId);
                        if (!opt) return;
                        assignMutation.mutate({
                          id: g.id,
                          data: { campaignId: opt.campaignId, slot: opt.slot },
                        });
                        setAssignPick((s) => ({ ...s, [g.id]: "" }));
                      }}
                    >
                      指派
                    </Button>
                    <Button
                      data-testid={`button-general-upgrade-${g.id}`}
                      size="sm"
                      disabled={busy || g.grade >= 5}
                      onClick={() => upgradeMutation.mutate({ id: g.id })}
                      className="bg-amber-700 text-white hover:bg-amber-600"
                    >
                      升階（成功率遞減）
                    </Button>
                    <Button
                      data-testid={`button-general-dismiss-${g.id}`}
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setConfirmDismiss(g.id)}
                    >
                      遣返
                    </Button>
                    {confirmDismiss === g.id && (
                      <span className="flex items-center gap-2 text-xs text-white/60">
                        確定？
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setConfirmDismiss(null);
                            dismissMutation.mutate({ id: g.id });
                          }}
                        >
                          確定遣返
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDismiss(null)}>
                          取消
                        </Button>
                      </span>
                    )}
                  </div>
                </GeneralCard>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** 武將卡片外框（名銜/品級/分類/戰力/技能/背景/升階敘事）。 */
function GeneralCard({
  general,
  children,
}: {
  general: General;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid={`general-card-${general.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-serif text-base font-bold text-white/90">
            {general.name}
            <span className="ml-2 text-sm font-normal text-white/50">
              「{general.title}」
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <GradeStars grade={general.grade} />
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs font-bold text-white/70">
              {general.categoryLabel}
            </span>
            <CombatMods general={general} />
          </div>
        </div>
        {general.status === "generating" ? (
          <span className="inline-flex items-center gap-1 rounded bg-sky-500/20 px-2 py-0.5 text-xs font-bold text-sky-200">
            <Loader2 className="h-3 w-3 animate-spin" /> 生成中
          </span>
        ) : (
          <span
            className={`rounded px-2 py-0.5 text-xs font-bold ${
              general.status === "candidate"
                ? "bg-amber-500/20 text-amber-200"
                : "bg-emerald-500/20 text-emerald-200"
            }`}
          >
            {general.status === "candidate" ? "候選" : "在營"}
          </span>
        )}
      </div>

      {general.status === "generating" ? (
        <p className="mt-2 text-xs leading-relaxed text-white/50">
          這名武將正在幕後生成中，離開此頁也不會中斷；稍待片刻就會出現在這裡。
        </p>
      ) : (
        <>
          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-white/60">
            {general.background}
          </p>

          <div className="mt-2">
            <SkillList general={general} />
          </div>
        </>
      )}

      {general.upgradeNarrative && (
        <p className="mt-2 rounded border border-white/10 bg-white/5 p-2 text-xs italic leading-relaxed text-white/60">
          {general.upgradeNarrative}
        </p>
      )}

      <div className="mt-3 border-t border-white/10 pt-3">{children}</div>
    </div>
  );
}
