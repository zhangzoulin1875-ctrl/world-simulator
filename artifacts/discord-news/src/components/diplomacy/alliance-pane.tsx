import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  useListAlliances,
  getListAlliancesQueryKey,
  useGetMyAlliance,
  getGetMyAllianceQueryKey,
  useCreateAlliance,
  useRenameAlliance,
  useDisbandAlliance,
  useApplyToAlliance,
  useKickAllianceMember,
  useLeaveAlliance,
  useRespondAllianceInvite,
  useRespondAllianceApplication,
} from "@workspace/api-client-react";
import type {
  Alliance,
  AllianceInvite,
  AllianceMembership,
} from "@workspace/api-client-react";
import { useCurrentUser } from "@/lib/current-user";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

export function AlliancePane() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: me } = useCurrentUser();
  const authenticated = me?.authenticated === true;
  const { data: nationEnvelope } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      enabled: authenticated,
      staleTime: 1000 * 30,
    },
  });
  const hasNation = nationEnvelope?.hasNation === true;

  const alliancesQuery = useListAlliances({
    query: {
      queryKey: getListAlliancesQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const mineQuery = useGetMyAlliance({
    query: {
      queryKey: getGetMyAllianceQueryKey(),
      enabled: authenticated && hasNation,
      refetchInterval: 30_000,
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListAlliancesQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetMyAllianceQueryKey(),
    });
  };

  const onErr = (title: string) => (err: unknown) =>
    toast({ title, description: apiErrorMessage(err) });

  const createM = useCreateAlliance({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "聯盟已建立" });
      },
      onError: onErr("建立失敗"),
    },
  });
  const renameM = useRenameAlliance({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "聯盟已改名" });
      },
      onError: onErr("改名失敗"),
    },
  });
  const disbandM = useDisbandAlliance({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "聯盟已解散" });
      },
      onError: onErr("解散失敗"),
    },
  });
  const applyM = useApplyToAlliance({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "申請已送出" });
      },
      onError: onErr("申請失敗"),
    },
  });
  const kickM = useKickAllianceMember({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已移除成員" });
      },
      onError: onErr("移除失敗"),
    },
  });
  const leaveM = useLeaveAlliance({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已退出聯盟" });
      },
      onError: onErr("退出失敗"),
    },
  });
  const respondInviteM = useRespondAllianceInvite({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已回覆邀請" });
      },
      onError: onErr("回覆失敗"),
    },
  });
  const respondAppM = useRespondAllianceApplication({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已回覆申請" });
      },
      onError: onErr("回覆失敗"),
    },
  });

  const [newName, setNewName] = useState("");
  const [renameValues, setRenameValues] = useState<Record<string, string>>({});
  const [confirmDisbandId, setConfirmDisbandId] = useState<string | null>(null);
  const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null);

  const alliances = alliancesQuery.data?.alliances ?? [];
  const myAllianceIds = alliancesQuery.data?.myAllianceIds ?? [];
  const mine = mineQuery.data;
  const memberships = mine?.memberships ?? [];

  const busy =
    createM.isPending ||
    renameM.isPending ||
    disbandM.isPending ||
    applyM.isPending ||
    kickM.isPending ||
    leaveM.isPending ||
    respondInviteM.isPending ||
    respondAppM.isPending;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div>
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold">
            <Users className="h-5 w-5" /> 聯盟
          </h2>
          <p className="mt-1 text-sm text-white/60">
            聯盟成員之間不可互相宣戰。加入聯盟不會自動參戰（僅保障獨立條約會自動參戰）。一個國家可同時加入多個聯盟。
          </p>
        </div>

        {/* 我的聯盟 */}
        {authenticated && hasNation && (
          <section className="rounded-2xl border border-white/15 bg-black/50 p-4 backdrop-blur">
            <h3 className="mb-3 font-serif text-base font-bold text-amber-200">
              我的聯盟
            </h3>

            {mineQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-white/60">
                <Loader2 className="h-4 w-4 animate-spin" /> 載入中…
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {memberships.length === 0 && (
                  <p className="text-sm text-white/60">
                    你尚未加入任何聯盟。建立一個新聯盟，或在下方世界聯盟列表申請加入。
                  </p>
                )}

                {memberships.map((m: AllianceMembership) => {
                  const alliance = m.alliance;
                  const isFounder = m.isFounder;
                  const renameValue = renameValues[alliance.id] ?? "";
                  return (
                    <div
                      key={alliance.id}
                      className="flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-lg font-bold">{alliance.name}</div>
                        <div className="text-xs text-white/50">
                          {alliance.memberCount} 個成員
                        </div>
                      </div>

                      {/* 成員清單 */}
                      <ul className="flex flex-col gap-1">
                        {alliance.members.map((member) => (
                          <li
                            key={member.nationId}
                            className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
                          >
                            <span className="flex items-center gap-2">
                              {member.name ?? "（未命名）"}
                              {member.isFounder && (
                                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                                  創始
                                </span>
                              )}
                              {member.isNpc && (
                                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">
                                  NPC
                                </span>
                              )}
                            </span>
                            {isFounder && !member.isFounder && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  kickM.mutate({
                                    id: alliance.id,
                                    data: { targetNationId: member.nationId },
                                  })
                                }
                                className="rounded bg-red-500/20 px-2 py-1 text-xs text-red-200 hover:bg-red-500/30 disabled:opacity-50"
                              >
                                移除
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>

                      {/* 創始國：改名 + 解散 */}
                      {isFounder && (
                        <div className="flex flex-col gap-3 border-t border-white/10 pt-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={renameValue}
                              onChange={(e) =>
                                setRenameValues((prev) => ({
                                  ...prev,
                                  [alliance.id]: e.target.value,
                                }))
                              }
                              placeholder={alliance.name}
                              maxLength={40}
                              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-sm outline-none focus:border-amber-400/50"
                            />
                            <button
                              disabled={busy || renameValue.trim().length === 0}
                              onClick={() =>
                                renameM.mutate({
                                  id: alliance.id,
                                  data: { name: renameValue.trim() },
                                })
                              }
                              className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50"
                            >
                              改名
                            </button>
                          </div>

                          {confirmDisbandId === alliance.id ? (
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-red-300">
                                確定解散？
                              </span>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  disbandM.mutate(
                                    { id: alliance.id },
                                    {
                                      onSettled: () =>
                                        setConfirmDisbandId(null),
                                    },
                                  )
                                }
                                className="rounded bg-red-500/30 px-2 py-1 text-xs text-red-100 hover:bg-red-500/40 disabled:opacity-50"
                              >
                                確定解散
                              </button>
                              <button
                                onClick={() => setConfirmDisbandId(null)}
                                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDisbandId(alliance.id)}
                              className="self-start rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/25"
                            >
                              解散聯盟
                            </button>
                          )}
                        </div>
                      )}

                      {/* 非創始國：退出 */}
                      {!isFounder && (
                        <div className="border-t border-white/10 pt-3">
                          {confirmLeaveId === alliance.id ? (
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-red-300">
                                確定退出？
                              </span>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  leaveM.mutate(
                                    { data: { allianceId: alliance.id } },
                                    {
                                      onSettled: () => setConfirmLeaveId(null),
                                    },
                                  )
                                }
                                className="rounded bg-red-500/30 px-2 py-1 text-xs text-red-100 hover:bg-red-500/40 disabled:opacity-50"
                              >
                                確定退出
                              </button>
                              <button
                                onClick={() => setConfirmLeaveId(null)}
                                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                              >
                                取消
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmLeaveId(alliance.id)}
                              className="rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/25"
                            >
                              退出聯盟
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* 建立新聯盟（多聯盟制：隨時可建立） */}
                <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="新聯盟名稱"
                    maxLength={40}
                    className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-sm outline-none focus:border-amber-400/50"
                  />
                  <button
                    disabled={busy || newName.trim().length === 0}
                    onClick={() =>
                      createM.mutate(
                        { data: { name: newName.trim() } },
                        { onSuccess: () => setNewName("") },
                      )
                    }
                    className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    建立聯盟
                  </button>
                </div>

                {/* 收到的邀請 */}
                {mine && mine.invitesForMe.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-xs text-white/50">收到的邀請</div>
                    {mine.invitesForMe.map((inv: AllianceInvite) => (
                      <div
                        key={inv.id}
                        className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
                      >
                        <span>{inv.allianceName}</span>
                        <span className="flex gap-2">
                          <button
                            disabled={busy}
                            onClick={() =>
                              respondInviteM.mutate({
                                id: inv.id,
                                data: { accept: true },
                              })
                            }
                            className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            加入
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              respondInviteM.mutate({
                                id: inv.id,
                                data: { accept: false },
                              })
                            }
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
                          >
                            婉拒
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 我送出的申請 */}
                {mine && mine.myApplications.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-xs text-white/50">已送出的申請</div>
                    {mine.myApplications.map((a: AllianceInvite) => (
                      <div
                        key={a.id}
                        className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/70"
                      >
                        {a.allianceName}（等待核准）
                      </div>
                    ))}
                  </div>
                )}

                {/* 他國對我創始聯盟的入盟申請 */}
                {mine && mine.applicationsToMyAlliance.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-xs text-white/50">入盟申請</div>
                    {mine.applicationsToMyAlliance.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
                      >
                        <span>
                          {a.nationName ?? "（未命名）"}
                          <span className="ml-2 text-xs text-white/40">
                            → {a.allianceName}
                          </span>
                        </span>
                        <span className="flex gap-2">
                          <button
                            disabled={busy}
                            onClick={() =>
                              respondAppM.mutate({
                                id: a.id,
                                data: { accept: true },
                              })
                            }
                            className="rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                          >
                            核准
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              respondAppM.mutate({
                                id: a.id,
                                data: { accept: false },
                              })
                            }
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-50"
                          >
                            婉拒
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* 世界聯盟列表 */}
        <section className="rounded-2xl border border-white/15 bg-black/50 p-4 backdrop-blur">
          <h3 className="mb-3 font-serif text-base font-bold text-sky-200">
            世界聯盟列表
          </h3>
          {alliancesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" /> 載入中…
            </div>
          ) : alliances.length === 0 ? (
            <p className="text-sm text-white/50">目前世界上還沒有任何聯盟。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {alliances.map((a: Alliance) => {
                const isMine = myAllianceIds.includes(a.id);
                const canApply = authenticated && hasNation && !isMine;
                const alreadyApplied = mine?.myApplications.some(
                  (x) => x.allianceId === a.id,
                );
                return (
                  <li
                    key={a.id}
                    className="rounded-lg bg-white/5 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-bold">
                        {a.name}
                        {isMine && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                            我方
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-white/50">
                          {a.memberCount} 個成員
                        </span>
                        {canApply && (
                          <button
                            disabled={busy || alreadyApplied}
                            onClick={() => applyM.mutate({ id: a.id })}
                            className="rounded bg-sky-500/20 px-2 py-1 text-xs text-sky-100 hover:bg-sky-500/30 disabled:opacity-50"
                          >
                            {alreadyApplied ? "已申請" : "申請加入"}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-white/50">
                      {a.members
                        .map((m) => m.name ?? "（未命名）")
                        .join("、")}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
