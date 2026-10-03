import React, { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Star, CheckCircle2, Lock, ArrowRight } from "lucide-react";
import {
  useStartTechTreeResearch,
  getGetTechTreeOverviewQueryKey,
} from "@workspace/api-client-react";
import type { TechTreeDomainView, TechTreeNodeView } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";

export function TechTreeView({ domainView }: { domainView: TechTreeDomainView }) {
  // Group nodes by era
  const eras = useMemo(() => {
    const map = new Map<string, TechTreeNodeView[]>();
    for (const node of domainView.nodes) {
      const arr = map.get(node.eraLabel) || [];
      arr.push(node);
      map.set(node.eraLabel, arr);
    }
    return Array.from(map.entries()).map(([label, nodes]) => ({
      label,
      nodes: nodes.sort((a, b) => {
        // Sort main lines first, then by lineKey, then sortOrder
        if (a.lineKind !== b.lineKind) return a.lineKind === "main" ? -1 : 1;
        if (a.lineKey !== b.lineKey) return a.lineKey.localeCompare(b.lineKey);
        return a.sortOrder - b.sortOrder;
      }),
    }));
  }, [domainView.nodes]);

  return (
    <div className="relative flex-1 overflow-x-auto overflow-y-auto bg-[#0A0D14] scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
      {/* Background Grid Pattern */}
      <div className="absolute inset-0 opacity-[0.03]" 
           style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      <div className="relative flex min-h-full w-max p-8 gap-16">
        {eras.map((era, index) => (
          <EraColumn key={index} label={era.label} nodes={era.nodes} />
        ))}
      </div>
    </div>
  );
}

function EraColumn({ label, nodes }: { label: string; nodes: TechTreeNodeView[] }) {
  // Group by lineKey to render distinct horizontal flows within the era
  const lines = useMemo(() => {
    const map = new Map<string, TechTreeNodeView[]>();
    for (const node of nodes) {
      const arr = map.get(node.lineKey) || [];
      arr.push(node);
      map.set(node.lineKey, arr);
    }
    return Array.from(map.values());
  }, [nodes]);

  return (
    <div className="flex flex-col gap-6 relative">
      <div className="sticky top-0 z-10 -mx-4 mb-4 bg-gradient-to-b from-[#0A0D14] via-[#0A0D14]/90 to-transparent px-4 pb-4 pt-2">
        <h2 className="font-serif text-2xl font-bold tracking-widest text-white/80 drop-shadow-md">
          {label}
        </h2>
        <div className="mt-2 h-0.5 w-full bg-gradient-to-r from-sky-500/50 to-transparent" />
      </div>

      <div className="flex flex-1 flex-col justify-center gap-12">
        {lines.map((lineNodes, idx) => (
          <TechLine key={idx} nodes={lineNodes} />
        ))}
      </div>
    </div>
  );
}

function TechLine({ nodes }: { nodes: TechTreeNodeView[] }) {
  return (
    <div className="flex items-center gap-6">
      {nodes.map((node, index) => (
        <React.Fragment key={node.id}>
          <TechNodeCard node={node} />
          {index < nodes.length - 1 && (
            <div className="h-0.5 w-12 bg-white/10 shrink-0 relative">
              <ArrowRight className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 h-3 w-3 text-white/20" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function TechNodeCard({ node }: { node: TechTreeNodeView }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const startMutation = useStartTechTreeResearch({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTechTreeOverviewQueryKey() });
        toast({ title: "開始研發", description: `已開始研發「${node.name}」` });
      },
      onError: (err) => {
        toast({ title: "無法研發", description: apiErrorMessage(err), variant: "destructive" });
      }
    }
  });

  const isResearched = node.status === "researched";
  const isResearching = node.status === "researching";
  const isAvailable = node.status === "available";
  const isLocked = node.status === "locked";

  let statusStyles = "";
  let icon = null;

  if (isResearched) {
    statusStyles = "border-emerald-500/40 bg-emerald-950/40 shadow-[0_0_15px_rgba(16,185,129,0.15)]";
    icon = <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
  } else if (isResearching) {
    statusStyles = "border-sky-400 bg-sky-950/50 shadow-[0_0_20px_rgba(56,189,248,0.3)] ring-1 ring-sky-400/50";
    icon = <Loader2 className="h-5 w-5 text-sky-300 animate-spin" />;
  } else if (isAvailable) {
    statusStyles = "border-amber-500/40 bg-black/60 hover:bg-amber-950/40 hover:border-amber-400/60 cursor-pointer transition-all hover:scale-105 shadow-lg";
  } else {
    statusStyles = "border-white/5 bg-black/30 opacity-60 grayscale-[50%]";
    icon = <Lock className="h-4 w-4 text-white/30" />;
  }

  const handleStart = () => {
    if (isAvailable && !startMutation.isPending) {
      startMutation.mutate({ data: { nodeId: node.id } });
    }
  };

  return (
    <div 
      className={`relative w-64 shrink-0 rounded-lg border p-4 backdrop-blur-sm ${statusStyles} ${node.isKey ? 'ring-2 ring-amber-400/30' : ''}`}
      onClick={handleStart}
      role={isAvailable ? "button" : "article"}
      tabIndex={isAvailable ? 0 : undefined}
    >
      {/* Key Tech Glow */}
      {node.isKey && (
        <div className="absolute -inset-1 rounded-lg bg-amber-400/10 blur-sm pointer-events-none" />
      )}

      <div className="relative">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {node.isKey && <Star className="h-4 w-4 text-amber-400 shrink-0 fill-amber-400/20" />}
            <h4 className={`font-serif font-bold leading-tight ${isResearched ? 'text-emerald-100' : isResearching ? 'text-sky-100' : isAvailable ? 'text-amber-100' : 'text-white/60'}`}>
              {node.name}
            </h4>
          </div>
          {icon && <div className="shrink-0">{icon}</div>}
        </div>

        <div className="mb-3 text-[11px] font-mono text-white/50 bg-black/40 inline-block px-1.5 py-0.5 rounded border border-white/5">
          成本: {formatBigNumber(node.costPoints)}
        </div>

        <p className="text-xs text-white/60 mb-3 line-clamp-2 leading-relaxed" title={node.description}>
          {node.description}
        </p>

        {node.effects.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-auto">
            {node.effects.map((eff, i) => (
              <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-sm whitespace-nowrap ${isResearched ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/10 text-white/70'}`}>
                {eff}
              </span>
            ))}
          </div>
        )}

        {isLocked && node.lockedReason && (
          <div className="mt-3 text-[10px] text-red-300/80 bg-red-950/30 px-2 py-1 rounded border border-red-500/20">
            {node.lockedReason}
          </div>
        )}

        {isAvailable && (
          <div className="mt-3 text-[10px] font-bold text-amber-300 text-center uppercase tracking-widest opacity-0 hover:opacity-100 transition-opacity">
            點擊開始研發
          </div>
        )}
      </div>
    </div>
  );
}
