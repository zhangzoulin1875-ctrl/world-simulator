import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import {
  useListVassalConsents,
  getListVassalConsentsQueryKey,
  useRespondVassalConsent,
} from "@workspace/api-client-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

/** 附庸請求狀態的繁中標籤。 */
function consentStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "等待宗主批准";
    case "approved":
      return "已批准（重新執行該行動即可）";
    case "denied":
      return "已被拒絕";
    case "consumed":
      return "已使用";
    default:
      return status;
  }
}

/**
 * 附庸外交同意卡片（條約分頁）：
 * - 宗主視角：選定國家是我的附庸且有待審請求 → 顯示批准／拒絕按鈕。
 * - 附庸視角：選定國家是我的宗主 → 顯示我送出的請求近況。
 * 沒有相關資料時不顯示。
 */
export function VassalConsentCard({ nation }: { nation: DiplomacyNation }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useListVassalConsents({
    query: {
      queryKey: getListVassalConsentsQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const respond = useRespondVassalConsent({
    mutation: {
      onSuccess: (res) => {
        toast({
          title: res.approved ? "已批准附庸請求" : "已拒絕附庸請求",
          description: res.approved
            ? "附庸重新執行該行動時即會生效。"
            : "已通知附庸該請求被拒絕。",
        });
        void queryClient.invalidateQueries({
          queryKey: getListVassalConsentsQueryKey(),
        });
      },
      onError: (err) =>
        toast({ title: "審核失敗", description: apiErrorMessage(err) }),
    },
  });

  // 宗主視角：選定國家（附庸）向我送出的待審請求。
  const incoming = (data?.incoming ?? []).filter(
    (r) => r.vassalNationId === nation.id,
  );
  // 附庸視角：我向選定國家（宗主）送出的請求近況。
  const outgoing = (data?.outgoing ?? []).filter(
    (r) => r.suzerainNationId === nation.id,
  );

  if (incoming.length === 0 && outgoing.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-indigo-400/30 bg-indigo-500/10 p-4 backdrop-blur"
      data-testid="vassal-consent-card"
    >
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-indigo-200">
        <ShieldQuestion className="h-4 w-4" />
        附庸外交同意
      </h3>
      <p className="mb-3 text-[11px] text-white/60">
        附庸的宣戰與聯盟行動需經宗主同意才能執行。
      </p>

      {incoming.length > 0 && (
        <div className="space-y-2">
          {incoming.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
              data-testid={`row-consent-incoming-${r.id}`}
            >
              <div className="text-xs text-white/80">
                附庸「{r.vassalName}」請求：
                <span className="font-bold text-indigo-100">
                  {r.actionLabel}
                  {r.subjectName ? `：${r.subjectName}` : ""}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => respond.mutate({ id: r.id, data: { approve: true } })}
                  disabled={respond.isPending}
                  className="flex items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-600/20 px-2.5 py-1 text-xs font-bold text-emerald-100 transition hover:bg-emerald-600/35 disabled:opacity-50"
                  data-testid={`button-consent-approve-${r.id}`}
                >
                  {respond.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  批准
                </button>
                <button
                  onClick={() => respond.mutate({ id: r.id, data: { approve: false } })}
                  disabled={respond.isPending}
                  className="flex items-center gap-1 rounded-lg border border-rose-400/40 bg-rose-600/20 px-2.5 py-1 text-xs font-bold text-rose-100 transition hover:bg-rose-600/35 disabled:opacity-50"
                  data-testid={`button-consent-deny-${r.id}`}
                >
                  <X className="h-3 w-3" />
                  拒絕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {outgoing.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
              data-testid={`row-consent-outgoing-${r.id}`}
            >
              <div className="text-xs text-white/80">
                {r.actionLabel}
                {r.subjectName ? `：${r.subjectName}` : ""}
              </div>
              <span
                className={
                  r.status === "approved"
                    ? "text-[11px] font-bold text-emerald-300"
                    : r.status === "denied"
                      ? "text-[11px] font-bold text-rose-300"
                      : "text-[11px] text-white/60"
                }
              >
                {consentStatusLabel(r.status)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
