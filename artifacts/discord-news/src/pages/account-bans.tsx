import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  Ban,
  Crown,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserX,
} from "lucide-react";

interface BanRow {
  discordUserId: string;
  username: string | null;
  reason: string | null;
  createdAt: string;
  nationName: string | null;
}

interface KnownAccount {
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  lastLoginAt: string | null;
  nationId: string | null;
  nationName: string | null;
}

interface Payload {
  bans: BanRow[];
  accounts: KnownAccount[];
}

async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* ignore */
  }
  return `請求失敗（${res.status}）`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 帳號的顯示名稱：Discord 顯示名 > 使用者名稱 > 國家名 > ID。 */
function accountLabel(a: {
  username: string | null;
  globalName: string | null;
  nationName?: string | null;
  discordUserId: string;
}): string {
  return (
    a.globalName ||
    a.username ||
    a.nationName ||
    a.discordUserId
  );
}

export default function AccountBans() {
  const { toast } = useToast();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  const isAdmin = Boolean(getAdminToken());

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await authedFetch("/api/admin/account-bans");
      if (!res.ok) throw new Error(await readError(res));
      setData((await res.json()) as Payload);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    void load();
  }, [isAdmin, load]);

  const ban = async (discordUserId: string, reason: string | null) => {
    setBusyId(discordUserId);
    try {
      const res = await authedFetch("/api/admin/account-bans", {
        method: "POST",
        body: JSON.stringify({ discordUserId, reason: reason || undefined }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({
        title: "已封禁帳號",
        description: "該帳號已無法登入，既有登入狀態已被撤銷。",
      });
      await load();
    } catch (err) {
      toast({
        title: "封禁失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const unban = async (discordUserId: string) => {
    if (!window.confirm("確定要解除此帳號的封禁嗎？該帳號將可重新登入。")) {
      return;
    }
    setBusyId(discordUserId);
    try {
      const res = await authedFetch(
        `/api/admin/account-bans/${encodeURIComponent(discordUserId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已解除封禁" });
      await load();
    } catch (err) {
      toast({
        title: "解除封禁失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const banManual = async () => {
    const id = manualId.trim();
    if (!id) {
      toast({ title: "請輸入 Discord 帳號 ID", variant: "destructive" });
      return;
    }
    setManualBusy(true);
    try {
      const res = await authedFetch("/api/admin/account-bans", {
        method: "POST",
        body: JSON.stringify({
          discordUserId: id,
          reason: manualReason.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已封禁帳號" });
      setManualId("");
      setManualReason("");
      await load();
    } catch (err) {
      toast({
        title: "封禁失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setManualBusy(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              需要管理金鑰
            </CardTitle>
            <CardDescription>
              請先在側邊欄底部輸入管理金鑰，才能檢視與管理帳號封禁。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const bans = data?.bans ?? [];
  const accounts = data?.accounts ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid="page-account-bans">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Ban className="h-6 w-6" />
            封禁帳號
          </h1>
          <p className="text-sm text-muted-foreground">
            封禁以 Discord 登入的帳號。被封禁者無法登入、既有登入狀態立即失效；其國家與資料保留，可隨時解除封禁。
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          data-testid="button-refresh"
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          重新整理
        </Button>
      </div>

      {/* 手動封禁 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">以 ID 封禁</CardTitle>
          <CardDescription>
            直接輸入 Discord 帳號 ID（純數字）進行封禁；封禁原因為選填。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <label className="block text-xs text-muted-foreground">
                Discord 帳號 ID
              </label>
              <Input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                placeholder="例如：123456789012345678"
                inputMode="numeric"
                className="w-full sm:w-64"
                data-testid="input-manual-id"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <label className="block text-xs text-muted-foreground">
                封禁原因（選填）
              </label>
              <Input
                value={manualReason}
                onChange={(e) => setManualReason(e.target.value)}
                placeholder="違反規則…"
                maxLength={500}
                data-testid="input-manual-reason"
              />
            </div>
            <Button
              variant="destructive"
              onClick={() => void banManual()}
              disabled={manualBusy}
              data-testid="button-ban-manual"
            >
              {manualBusy ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Ban className="mr-1.5 h-4 w-4" />
              )}
              封禁
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入中…
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 已封禁帳號 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserX className="h-4 w-4 text-red-500" />
                已封禁帳號
                <Badge variant="outline">{bans.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bans.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  目前沒有被封禁的帳號。
                </p>
              ) : (
                <ul className="divide-y">
                  {bans.map((b) => (
                    <li
                      key={b.discordUserId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                      data-testid={`ban-${b.discordUserId}`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          <span className="truncate">
                            {b.username || b.nationName || "未知帳號"}
                          </span>
                          {b.nationName && (
                            <Badge variant="secondary" className="gap-1">
                              <Crown className="h-3 w-3" />
                              {b.nationName}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          ID：
                          <span className="font-mono">{b.discordUserId}</span>
                          <span className="mx-1.5">·</span>
                          {formatDateTime(b.createdAt)} 封禁
                        </div>
                        {b.reason && (
                          <div className="text-xs text-muted-foreground">
                            原因：{b.reason}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void unban(b.discordUserId)}
                        disabled={busyId === b.discordUserId}
                        data-testid={`button-unban-${b.discordUserId}`}
                      >
                        {busyId === b.discordUserId ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-1.5 h-4 w-4" />
                        )}
                        解除封禁
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* 已知帳號 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                已知帳號
                <Badge variant="outline">{accounts.length}</Badge>
              </CardTitle>
              <CardDescription>
                曾登入或擁有國家的帳號。點「封禁」即可停用其登入。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  尚無可封禁的已知帳號。
                </p>
              ) : (
                <ul className="divide-y">
                  {accounts.map((a) => (
                    <li
                      key={a.discordUserId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                      data-testid={`account-${a.discordUserId}`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          <span className="truncate">{accountLabel(a)}</span>
                          {a.nationName && (
                            <Badge variant="secondary" className="gap-1">
                              <Crown className="h-3 w-3" />
                              {a.nationName}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          ID：
                          <span className="font-mono">{a.discordUserId}</span>
                          {a.lastLoginAt && (
                            <>
                              <span className="mx-1.5">·</span>
                              最後登入 {formatDateTime(a.lastLoginAt)}
                            </>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void ban(a.discordUserId, null)}
                        disabled={busyId === a.discordUserId}
                        data-testid={`button-ban-${a.discordUserId}`}
                      >
                        {busyId === a.discordUserId ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Ban className="mr-1.5 h-4 w-4" />
                        )}
                        封禁
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
