import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type AutopilotStyle = "steady" | "balanced" | "expansion";

export interface AutopilotAction {
  at: string;
  area: string;
  text: string;
  ok: boolean;
}

export interface AutopilotData {
  enabled: boolean;
  style: AutopilotStyle;
  directive: string;
  enabledAt: string | null;
  turnsRun: number;
  recentActions: AutopilotAction[];
}

export interface EnableAutopilotPayload {
  style: AutopilotStyle;
  directive?: string;
}

export const AUTOPILOT_QUERY_KEY = ["autopilot"] as const;

async function fetchAutopilot(): Promise<AutopilotData> {
  const res = await fetch("/api/player/autopilot", {
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(
      typeof data?.error === "string" ? data.error : `HTTP ${res.status}`
    );
    (err as any).status = res.status;
    (err as any).code = data?.code;
    throw err;
  }
  return res.json();
}

async function enableAutopilot(payload: EnableAutopilotPayload): Promise<AutopilotData> {
  const res = await fetch("/api/player/autopilot/enable", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).status = res.status;
    (err as any).code = data?.code;
    throw err;
  }
  return data as AutopilotData;
}

async function disableAutopilot(): Promise<AutopilotData> {
  const res = await fetch("/api/player/autopilot/disable", {
    method: "POST",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).status = res.status;
    (err as any).code = data?.code;
    throw err;
  }
  return data as AutopilotData;
}

export function isAutopilotLockedResponse(
  res: { status: number },
  body?: { code?: string }
): boolean {
  return res.status === 423 && body?.code === "AUTOPILOT_LOCKED";
}

export function useAutopilot(options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: AUTOPILOT_QUERY_KEY,
    queryFn: fetchAutopilot,
    refetchInterval: 60_000,
    retry: false,
    enabled: options?.enabled !== false,
  });

  return {
    ...query,
    data: query.data,
    isLocked: query.data?.enabled === true,
  };
}

export function useEnableAutopilot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: enableAutopilot,
    onSuccess: (data) => {
      queryClient.setQueryData(AUTOPILOT_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: AUTOPILOT_QUERY_KEY });
    },
  });
}

export function useDisableAutopilot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disableAutopilot,
    onSuccess: (data) => {
      queryClient.setQueryData(AUTOPILOT_QUERY_KEY, data);
      queryClient.invalidateQueries({ queryKey: AUTOPILOT_QUERY_KEY });
    },
  });
}
