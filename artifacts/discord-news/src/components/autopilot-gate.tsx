import React from "react";
import { Bot, Power, Loader2 } from "lucide-react";
import { useAutopilot, useDisableAutopilot } from "@/lib/autopilot";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface AutopilotGateProps {
  children: React.ReactNode;
}

export function AutopilotGate({ children }: AutopilotGateProps) {
  const { isLocked, isLoading, isError } = useAutopilot();
  const disableMutation = useDisableAutopilot();
  const { toast } = useToast();

  const handleDisable = async () => {
    try {
      await disableMutation.mutateAsync();
      toast({
        title: "AI 全權託管已解除",
        description: "你已恢復國家手動操作權限。",
      });
    } catch (err: any) {
      toast({
        title: "解除託管失敗",
        description: err.message || "發生未知錯誤",
        variant: "destructive",
      });
    }
  };

  if (isLoading || isError || !isLocked) {
    return <>{children}</>;
  }

  return (
    <div className="relative min-h-screen">
      <div
        className="fixed top-0 inset-x-0 z-[9999] flex items-center justify-between border-b border-amber-500/30 bg-black/90 px-4 py-2.5 text-white shadow-lg backdrop-blur"
        data-testid="banner-autopilot-locked"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bot className="h-5 w-5 text-amber-400 animate-pulse" />
          <span className="text-amber-200">AI 託管中，操作已鎖定</span>
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="h-8 gap-1.5 text-xs font-semibold"
          onClick={handleDisable}
          disabled={disableMutation.isPending}
          data-testid="button-banner-disable-autopilot"
        >
          {disableMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Power className="h-3.5 w-3.5" />
          )}
          解除託管
        </Button>
      </div>

      <div className="pointer-events-none select-none opacity-60">
        {children}
      </div>
    </div>
  );
}
