import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Flag,
  Landmark,
  Loader2,
  Lock,
  LogOut,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useUpdatePlayerNation,
  useQuitNation,
  useDeletePlayerNation,
  useGenerateAdvisorTips,
  getGetPlayerNationQueryKey,
  getListUnownedNationsQueryKey,
  getListClaimedRegionsQueryKey,
} from "@workspace/api-client-react";
import type { PlayerNation } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { uploadPlayerImage } from "@/lib/player-image-upload";

/** 圖片欄位：預覽＋上傳＋清除（清除代表改回預設）。 */
function SettingsImageField({
  label,
  value,
  onChange,
  wide = false,
  testId,
}: {
  label: string;
  value: string | null;
  onChange: (url: string | null) => void;
  wide?: boolean;
  testId: string;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadPlayerImage(file);
      onChange(url);
    } catch (err) {
      toast({
        variant: "destructive",
        title: `${label}上傳失敗`,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const previewCls = wide
    ? "h-12 w-20 rounded border border-white/25 object-cover"
    : "h-10 w-14 rounded border border-white/25 object-cover";

  return (
    <div>
      <div className="mb-1 text-xs text-white/65">{label}</div>
      <div className="flex items-center gap-2">
        {value ? (
          <img src={value} alt={label} className={previewCls} />
        ) : (
          <div
            className={`flex items-center justify-center rounded border border-dashed border-white/25 bg-white/5 ${wide ? "h-12 w-20" : "h-10 w-14"}`}
          >
            <Flag className="h-4 w-4 text-white/35" />
          </div>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/45 px-3 py-1.5 text-xs font-semibold transition hover:bg-black/70 disabled:opacity-50"
          data-testid={`settings-upload-${testId}`}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          上傳
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 rounded-lg border border-white/15 bg-black/35 px-2 py-1.5 text-xs text-white/70 transition hover:bg-black/60"
            title="清除（改用預設）"
            data-testid={`settings-clear-${testId}`}
          >
            <X className="h-3.5 w-3.5" />
            清除
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

/**
 * 遊戲內設定對話框：編輯國名／領導者／外觀圖片（政體唯讀），
 * 以及退出國家、刪除國家（雙重確認）。
 */
export function GameSettingsDialog({
  open,
  onOpenChange,
  nation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nation: PlayerNation;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(nation.name ?? "");
  const [leaderName, setLeaderName] = useState(nation.leaderName ?? "");
  const [flagUrl, setFlagUrl] = useState<string | null>(nation.flagUrl);
  const [emblemUrl, setEmblemUrl] = useState<string | null>(nation.emblemUrl);
  // 玩家自訂地圖顏色（#rrggbb）；null = 使用預設調色盤。只在玩家動過才送出。
  const [mapColor, setMapColor] = useState<string | null>(
    nation.mapColor ?? null,
  );
  const [mapColorTouched, setMapColorTouched] = useState(false);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [kanbanUrl, setKanbanUrl] = useState<string | null>(null);
  const [bgTouched, setBgTouched] = useState(false);
  const [kanbanTouched, setKanbanTouched] = useState(false);
  const [advisorStyle, setAdvisorStyle] = useState(nation.advisorStyle ?? "");
  const [dmDiplomacy, setDmDiplomacy] = useState(
    nation.dmDiplomacyEnabled ?? true,
  );
  const [dmPolitics, setDmPolitics] = useState(
    nation.dmPoliticsEnabled ?? true,
  );

  const [confirmQuit, setConfirmQuit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");

  // 開啟時同步最新資料；背景／看板娘顯示的是解析後 URL（可能是全域預設），
  // 只有在玩家主動變更時才送出，避免把全域預設誤存成個人覆蓋。
  useEffect(() => {
    if (open) {
      setName(nation.name ?? "");
      setLeaderName(nation.leaderName ?? "");
      setFlagUrl(nation.flagUrl);
      setEmblemUrl(nation.emblemUrl);
      setMapColor(nation.mapColor ?? null);
      setMapColorTouched(false);
      setBackgroundUrl(nation.backgroundUrl);
      setKanbanUrl(nation.kanbanUrl);
      setBgTouched(false);
      setKanbanTouched(false);
      setAdvisorStyle(nation.advisorStyle ?? "");
      setDmDiplomacy(nation.dmDiplomacyEnabled ?? true);
      setDmPolitics(nation.dmPoliticsEnabled ?? true);
      setConfirmQuit(false);
      setConfirmDelete(false);
      setDeleteText("");
    }
  }, [open, nation]);

  const invalidateNation = () =>
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });

  const updateMutation = useUpdatePlayerNation({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPlayerNationQueryKey(), data);
        invalidateNation();
        toast({ title: "已儲存國家設定" });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "儲存失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  const quitMutation = useQuitNation({
    mutation: {
      onSuccess: () => {
        invalidateNation();
        queryClient.invalidateQueries({
          queryKey: getListUnownedNationsQueryKey(),
        });
        toast({
          title: "已退出國家",
          description: "你的國家已成為無主國家，之後任何玩家（包括你）都可以接手。",
        });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "退出失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  const deleteMutation = useDeletePlayerNation({
    mutation: {
      onSuccess: () => {
        invalidateNation();
        queryClient.invalidateQueries({
          queryKey: getListClaimedRegionsQueryKey(),
        });
        toast({
          title: "國家已刪除",
          description: "國家與其地區歸屬已全部移除，你可以重新建國。",
        });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "刪除失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  // Task #303 — 依已存的說話風格產生一批顧問小tips（AI，bulk 模型）。
  const tipsMutation = useGenerateAdvisorTips({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPlayerNationQueryKey(), data);
        invalidateNation();
        toast({
          title: "顧問小提示已更新",
          description: "已依你的說話風格產生一批新的小提示。",
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "小提示產生失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  const save = () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "國名不可為空" });
      return;
    }
    if (!leaderName.trim()) {
      toast({ variant: "destructive", title: "領導者名稱不可為空" });
      return;
    }
    const styleTrim = advisorStyle.trim();
    const originalStyle = (nation.advisorStyle ?? "").trim();
    const styleChanged = styleTrim !== originalStyle;
    updateMutation.mutate(
      {
        data: {
          name: name.trim(),
          leaderName: leaderName.trim(),
          flagUrl,
          emblemUrl,
          ...(mapColorTouched ? { mapColor } : {}),
          ...(bgTouched ? { backgroundUrl } : {}),
          ...(kanbanTouched ? { kanbanUrl } : {}),
          ...(styleChanged ? { advisorStyle: styleTrim || null } : {}),
          dmDiplomacyEnabled: dmDiplomacy,
          dmPoliticsEnabled: dmPolitics,
        },
      },
      {
        // 只有在說話風格有變更且非空時，才在存檔後觸發一次 AI 產生小tips。
        onSuccess: () => {
          if (styleChanged && styleTrim) tipsMutation.mutate();
        },
      },
    );
  };

  const regenerateTips = () => {
    const styleTrim = advisorStyle.trim();
    if (!styleTrim) {
      toast({ variant: "destructive", title: "請先輸入說話風格" });
      return;
    }
    const originalStyle = (nation.advisorStyle ?? "").trim();
    // 若風格有改動，先存檔再產生，確保 AI 依最新風格生成。
    if (styleTrim !== originalStyle) {
      updateMutation.mutate(
        { data: { advisorStyle: styleTrim } },
        { onSuccess: () => tipsMutation.mutate() },
      );
    } else {
      tipsMutation.mutate();
    }
  };

  const anyPending =
    updateMutation.isPending ||
    quitMutation.isPending ||
    deleteMutation.isPending ||
    tipsMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !anyPending && onOpenChange(v)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-white/15 bg-zinc-900 text-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif">國家設定</DialogTitle>
          <DialogDescription className="text-white/60">
            管理國家名稱與外觀。政體已於建國時鎖定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="mb-1 text-xs text-white/65">國名</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              className="w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none focus:border-amber-300/70"
              data-testid="settings-input-name"
            />
          </div>

          <div>
            <div className="mb-1 text-xs text-white/65">領導者名稱</div>
            <input
              value={leaderName}
              onChange={(e) => setLeaderName(e.target.value)}
              maxLength={40}
              className="w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none focus:border-amber-300/70"
              data-testid="settings-input-leader"
            />
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <Landmark className="h-4 w-4 shrink-0 text-white/50" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[10px] text-white/50">政體（已鎖定）</div>
              <div className="truncate text-sm font-semibold" data-testid="settings-government">
                {nation.government ?? "政體未定"}
              </div>
            </div>
            <Lock className="h-3.5 w-3.5 shrink-0 text-white/40" />
          </div>

          {/* 玩家自訂地圖顏色：世界地圖政治視圖領土上色用；清除後回到預設配色。 */}
          <div>
            <div className="mb-1 text-xs text-white/65">地圖顏色</div>
            <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              <input
                type="color"
                value={mapColor ?? "#d97706"}
                onChange={(e) => {
                  setMapColor(e.target.value);
                  setMapColorTouched(true);
                }}
                className="h-8 w-12 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent"
                data-testid="settings-map-color"
              />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-sm font-semibold">
                  {mapColor ? mapColor.toUpperCase() : "未設定（使用預設配色）"}
                </div>
                <div className="text-[10px] text-white/50">
                  世界地圖政治視圖上你的國家領土顏色
                </div>
              </div>
              {mapColor && (
                <button
                  type="button"
                  onClick={() => {
                    setMapColor(null);
                    setMapColorTouched(true);
                  }}
                  className="shrink-0 rounded-lg border border-white/20 px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/10"
                  data-testid="settings-map-color-clear"
                >
                  清除
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsImageField
              label="國旗"
              value={flagUrl}
              onChange={setFlagUrl}
              testId="flag"
            />
            <SettingsImageField
              label="國徽"
              value={emblemUrl}
              onChange={setEmblemUrl}
              testId="emblem"
            />
            <SettingsImageField
              label="背景圖"
              value={backgroundUrl}
              onChange={(v) => {
                setBackgroundUrl(v);
                setBgTouched(true);
              }}
              wide
              testId="background"
            />
            <SettingsImageField
              label="看板顧問"
              value={kanbanUrl}
              onChange={(v) => {
                setKanbanUrl(v);
                setKanbanTouched(true);
              }}
              wide
              testId="kanban"
            />
          </div>

          {/* Task #303 — 看板顧問說話風格：存檔時用 AI 依此人設一次產生一批小tips。 */}
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs text-white/65">看板顧問說話風格</span>
              <button
                type="button"
                onClick={regenerateTips}
                disabled={anyPending || !advisorStyle.trim()}
                className="flex items-center gap-1 rounded-lg border border-amber-300/40 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40"
                data-testid="settings-regenerate-tips"
              >
                {tipsMutation.isPending && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                重新產生小提示
              </button>
            </div>
            <textarea
              value={advisorStyle}
              onChange={(e) => setAdvisorStyle(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="例：溫柔體貼的軍師，總是用鼓勵的語氣提醒你；或：毒舌傲嬌的參謀，嘴上嫌棄但其實很關心你。"
              className="w-full resize-none rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none focus:border-amber-300/70"
              data-testid="settings-advisor-style"
            />
            <div className="mt-1 text-[10px] leading-relaxed text-white/45">
              儲存後會依此風格用 AI 產生一批小提示，之後在首頁閒置時隨機顯示（最多 {200} 字）。
              留空則清除自訂風格，改用內建題庫。
            </div>
          </div>

          {/* Discord 私訊通知開關（外交／內政各自獨立；站內通知不受影響） */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              {dmDiplomacy ? (
                <Bell className="h-4 w-4 shrink-0 text-amber-300/90" />
              ) : (
                <BellOff className="h-4 w-4 shrink-0 text-white/40" />
              )}
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-sm font-semibold">外交私訊</div>
                <div className="text-[10px] text-white/50">
                  外交事件（新訊息／條約提案／條約回覆／宣戰）時由機器人 Discord 私訊你
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={dmDiplomacy}
                onClick={() => setDmDiplomacy((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  dmDiplomacy ? "bg-amber-500/85" : "bg-white/20"
                }`}
                data-testid="settings-toggle-dm-diplomacy"
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    dmDiplomacy ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
              {dmPolitics ? (
                <Bell className="h-4 w-4 shrink-0 text-amber-300/90" />
              ) : (
                <BellOff className="h-4 w-4 shrink-0 text-white/40" />
              )}
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-sm font-semibold">內政私訊</div>
                <div className="text-[10px] text-white/50">
                  每回合內政結算摘要（政策成敗／隨機事件／政變）由機器人 Discord 私訊你
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={dmPolitics}
                onClick={() => setDmPolitics((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  dmPolitics ? "bg-amber-500/85" : "bg-white/20"
                }`}
                data-testid="settings-toggle-dm-politics"
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    dmPolitics ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>

          <button
            onClick={save}
            disabled={anyPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
            data-testid="settings-save"
          >
            {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            儲存設定
          </button>

          {/* 危險區域 */}
          <div className="space-y-3 rounded-xl border border-red-400/25 bg-red-950/25 p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-red-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              危險區域
            </div>

            {/* 退出國家 */}
            {confirmQuit ? (
              <div className="space-y-2 rounded-lg border border-red-400/30 bg-black/30 p-3">
                <p className="text-xs leading-relaxed text-white/75">
                  退出後你與國家脫鉤：國家與其地區歸屬會保留在地圖上成為
                  <span className="font-bold text-amber-200">無主國家</span>
                  ，之後可被任何玩家接手；你可以重新建國，但無法直接回到原國家。
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => quitMutation.mutate()}
                    disabled={anyPending}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold transition hover:bg-red-500 disabled:opacity-50"
                    data-testid="confirm-quit-nation"
                  >
                    {quitMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    確定退出國家
                  </button>
                  <button
                    onClick={() => setConfirmQuit(false)}
                    disabled={anyPending}
                    className="rounded-lg border border-white/20 bg-black/45 px-3 py-2 text-xs font-semibold transition hover:bg-black/70"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setConfirmQuit(true);
                  setConfirmDelete(false);
                }}
                disabled={anyPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200 transition hover:bg-red-500/25"
                data-testid="button-quit-nation"
              >
                <LogOut className="h-3.5 w-3.5" />
                退出國家（國家保留成為無主）
              </button>
            )}

            {/* 刪除國家（雙重確認） */}
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg border border-red-400/30 bg-black/30 p-3">
                <p className="text-xs leading-relaxed text-white/75">
                  <span className="font-bold text-red-300">此動作無法復原！</span>
                  國家與其全部地區歸屬將被永久刪除，地區變回無人掌控。
                  請輸入「<span className="font-bold text-red-200">刪除</span>」以確認：
                </p>
                <input
                  value={deleteText}
                  onChange={(e) => setDeleteText(e.target.value)}
                  placeholder="輸入：刪除"
                  className="w-full rounded-lg border border-red-400/40 bg-black/40 px-3 py-2 text-sm outline-none focus:border-red-300"
                  data-testid="input-delete-confirm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => deleteMutation.mutate()}
                    disabled={anyPending || deleteText.trim() !== "刪除"}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid="confirm-delete-nation"
                  >
                    {deleteMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    永久刪除國家
                  </button>
                  <button
                    onClick={() => {
                      setConfirmDelete(false);
                      setDeleteText("");
                    }}
                    disabled={anyPending}
                    className="rounded-lg border border-white/20 bg-black/45 px-3 py-2 text-xs font-semibold transition hover:bg-black/70"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setConfirmDelete(true);
                  setConfirmQuit(false);
                }}
                disabled={anyPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-500/50 bg-red-600/15 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-600/30"
                data-testid="button-delete-nation"
              >
                <Trash2 className="h-3.5 w-3.5" />
                刪除國家（不可復原）
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
