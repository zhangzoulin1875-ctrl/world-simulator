import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCurrentUserQueryKey,
  useLogout,
} from "@workspace/api-client-react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useCurrentUser,
  startDiscordLogin,
  discordAvatarUrl,
} from "@/lib/current-user";

/**
 * Global listener for the OAuth popup's success signal. Mounted once at the App
 * root so login refreshes the session no matter which page (news site or the
 * game pages rendered outside the news Layout) initiated it. Renders nothing.
 */
export function DiscordAuthListener() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const d = e?.data as { type?: string; ok?: boolean } | null;
      if (d && typeof d === "object" && d.type === "discord-auth") {
        queryClient.invalidateQueries({
          queryKey: getGetCurrentUserQueryKey(),
        });
        if (d.ok) toast({ title: "已使用 Discord 登入" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient, toast]);

  return null;
}

export function DiscordAuthPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useCurrentUser();

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetCurrentUserQueryKey(),
        });
        toast({ title: "已登出" });
      },
    },
  });

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }

  const user = data?.authenticated ? data.user : null;

  if (!user) {
    return (
      <div className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-center gap-2"
          onClick={() => startDiscordLogin()}
        >
          <LogIn className="w-4 h-4" />
          使用 Discord 登入
        </Button>
        <p className="text-[11px] leading-snug text-muted-foreground">
          伺服器管理員登入後即可管理自己社群的專區。
        </p>
      </div>
    );
  }

  const avatar = discordAvatarUrl(user.discordUserId, user.avatar);
  const displayName = user.globalName || user.username;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-md border border-border/60 bg-secondary/40 p-2.5">
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className="h-8 w-8 rounded-full shrink-0"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {displayName}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            @{user.username}
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-center gap-2 text-muted-foreground"
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
      >
        <LogOut className="w-4 h-4" />
        登出
      </Button>
    </div>
  );
}
