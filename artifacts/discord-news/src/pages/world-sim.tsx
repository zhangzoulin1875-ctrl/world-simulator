import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { ShieldAlert, Wand2 } from "lucide-react";
import {
  authedFetch,
  readError,
  type AttitudeNation,
  type AuditEntry,
  type GuardEventEntry,
  type GuardPlayerSummaryEntry,
  type ProposeResult,
  type WorldSimSettings,
} from "@/components/world-sim/shared";
import { WorldSimSettingsCard } from "@/components/world-sim/world-sim-settings-card";
import { AiJudgmentCard } from "@/components/world-sim/ai-judgment-card";
import { NpcAttitudesCard } from "@/components/world-sim/npc-attitudes-card";
import { InstructionCard } from "@/components/world-sim/instruction-card";
import { ProposalCard } from "@/components/world-sim/proposal-card";
import { AuditsCard } from "@/components/world-sim/audits-card";
import { NpcChatGuardCard } from "@/components/world-sim/npc-chat-guard-card";

export default function WorldSim() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const [instruction, setInstruction] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<ProposeResult | null>(null);
  const [applying, setApplying] = useState(false);

  const [audits, setAudits] = useState<AuditEntry[] | null>(null);
  const [auditsError, setAuditsError] = useState<string | null>(null);
  const [auditsLoading, setAuditsLoading] = useState(true);

  const [guardEvents, setGuardEvents] = useState<GuardEventEntry[] | null>(
    null,
  );
  const [guardError, setGuardError] = useState<string | null>(null);
  const [guardLoading, setGuardLoading] = useState(true);
  const [guardSummary, setGuardSummary] = useState<
    GuardPlayerSummaryEntry[] | null
  >(null);
  const [guardFilterName, setGuardFilterName] = useState("");

  const [settings, setSettings] = useState<WorldSimSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [savingField, setSavingField] = useState<keyof WorldSimSettings | null>(
    null,
  );
  const [directive, setDirective] = useState("");

  const [attNations, setAttNations] = useState<AttitudeNation[] | null>(null);
  const [attLoading, setAttLoading] = useState(true);
  const [attDrafts, setAttDrafts] = useState<Record<string, string>>({});
  const [attSavingId, setAttSavingId] = useState<string | null>(null);
  const [attGenId, setAttGenId] = useState<string | null>(null);

  const loadAudits = useCallback(async () => {
    setAuditsLoading(true);
    try {
      const res = await authedFetch("/api/world-sim/audits");
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setAudits((data.audits ?? []) as AuditEntry[]);
      setAuditsError(null);
    } catch (err) {
      setAuditsError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setAuditsLoading(false);
    }
  }, []);

  const loadGuardEvents = useCallback(async (playerName?: string) => {
    setGuardLoading(true);
    try {
      const params = new URLSearchParams();
      const trimmed = playerName?.trim();
      if (trimmed) params.set("playerName", trimmed);
      const qs = params.toString();
      const res = await authedFetch(
        `/api/world-sim/npc-chat-guard-events${qs ? `?${qs}` : ""}`,
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setGuardEvents((data.events ?? []) as GuardEventEntry[]);
      setGuardSummary((data.summary ?? []) as GuardPlayerSummaryEntry[]);
      setGuardError(null);
    } catch (err) {
      setGuardError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setGuardLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await authedFetch("/api/world-sim/settings");
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setSettings(data.settings as WorldSimSettings);
    } catch {
      setSettings(null);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const loadAttitudeNations = useCallback(async () => {
    setAttLoading(true);
    try {
      const res = await authedFetch("/api/npc-nations");
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const npcs = (data.npcs ?? []) as AttitudeNation[];
      const players = (data.players ?? []) as AttitudeNation[];
      const list = [...npcs, ...players.filter((p) => !p.isOwned)];
      setAttNations(list);
      setAttDrafts(
        Object.fromEntries(list.map((n) => [n.id, n.diplomaticAttitude ?? ""])),
      );
    } catch {
      setAttNations(null);
    } finally {
      setAttLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadAudits();
      void loadGuardEvents();
      void loadSettings();
      void loadAttitudeNations();
    }
  }, [isAdmin, loadAudits, loadGuardEvents, loadSettings, loadAttitudeNations]);

  useEffect(() => {
    setDirective(settings?.aiJudgmentDirective ?? "");
  }, [settings?.aiJudgmentDirective]);

  const saveSetting = async (patch: Partial<WorldSimSettings>) => {
    const field = Object.keys(patch)[0] as keyof WorldSimSettings;
    setSavingField(field);
    try {
      const res = await authedFetch("/api/world-sim/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setSettings(data.settings as WorldSimSettings);
    } catch (err) {
      toast({
        title: "更新設定失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSavingField(null);
    }
  };

  const [runningNow, setRunningNow] = useState(false);
  const runJudgmentNow = async () => {
    setRunningNow(true);
    try {
      const res = await authedFetch("/api/world-sim/run-now", {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const s = (data.summary ?? {}) as {
        campaignsSettledCount?: number;
      };
      if (data.settings) setSettings(data.settings as WorldSimSettings);
      toast({
        title: "已完成立即判定",
        description: `結算戰役 ${s.campaignsSettledCount ?? 0}`,
      });
      void loadAudits();
    } catch (err) {
      toast({
        title: "立即判定失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setRunningNow(false);
    }
  };

  const [clearingCooldowns, setClearingCooldowns] = useState(false);
  const clearRegionCooldowns = async () => {
    setClearingCooldowns(true);
    try {
      const res = await authedFetch("/api/world-sim/clear-region-cooldowns", {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { clearedCount?: number };
      const n = data.clearedCount ?? 0;
      toast({
        title: "已解除地區冷卻",
        description:
          n > 0 ? `共解除 ${n} 個冷卻中的地區冷卻` : "目前沒有冷卻中的地區",
      });
    } catch (err) {
      toast({
        title: "解除地區冷卻失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setClearingCooldowns(false);
    }
  };

  const saveAttitude = async (id: string) => {
    setAttSavingId(id);
    try {
      const draft = (attDrafts[id] ?? "").trim();
      const res = await authedFetch(`/api/npc-nations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          diplomaticAttitude: draft === "" ? null : draft,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setAttNations((prev) =>
        prev
          ? prev.map((n) =>
              n.id === id
                ? { ...n, diplomaticAttitude: draft === "" ? null : draft }
                : n,
            )
          : prev,
      );
      toast({ title: "已儲存外交態度" });
    } catch (err) {
      toast({
        title: "儲存失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setAttSavingId(null);
    }
  };

  const generateAttitude = async (id: string) => {
    setAttGenId(id);
    try {
      const res = await authedFetch(
        `/api/npc-nations/${id}/diplomatic-attitude`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const attitude = (data.diplomaticAttitude ?? "") as string;
      setAttDrafts((prev) => ({ ...prev, [id]: attitude }));
      setAttNations((prev) =>
        prev
          ? prev.map((n) =>
              n.id === id ? { ...n, diplomaticAttitude: attitude } : n,
            )
          : prev,
      );
      toast({ title: "已生成外交態度", description: "已自動填入並儲存。" });
    } catch (err) {
      toast({
        title: "生成失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setAttGenId(null);
    }
  };

  const propose = async () => {
    const trimmed = instruction.trim();
    if (trimmed === "") {
      toast({
        title: "請先輸入指令",
        description: "描述你想讓 AI 對世界做的變化。",
        variant: "destructive",
      });
      return;
    }
    setProposing(true);
    setProposal(null);
    try {
      const res = await authedFetch("/api/world-sim/propose", {
        method: "POST",
        body: JSON.stringify({ instruction: trimmed }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as ProposeResult;
      setProposal(data);
    } catch (err) {
      toast({
        title: "生成提案失敗",
        description: err instanceof Error ? err.message : "請稍後再試或調整指令",
        variant: "destructive",
      });
    } finally {
      setProposing(false);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    const { creates, updates, deletes } = proposal.counts;
    if (
      !window.confirm(
        `確定要套用此提案嗎？將新增 ${creates}、修改 ${updates}、刪除 ${deletes} 個 NPC／無主國家並重畫其領土。玩家國家與其領土完全不受影響。此動作無法復原。`,
      )
    ) {
      return;
    }
    setApplying(true);
    try {
      const res = await authedFetch("/api/world-sim/apply", {
        method: "POST",
        body: JSON.stringify({
          proposal: proposal.proposal,
          instruction: instruction.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({
        title: "已套用",
        description: "世界變更已寫入，地圖與國家管理頁將反映結果。",
      });
      setProposal(null);
      setInstruction("");
      void loadAudits();
    } catch (err) {
      toast({
        title: "套用失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setApplying(false);
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
              請先在側邊欄底部輸入管理金鑰，才能使用 AI 世界模擬。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-3xl space-y-6 p-6"
      data-testid="page-world-sim"
    >
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
          <Wand2 className="h-6 w-6" />
          AI 世界模擬
        </h1>
        <p className="text-sm text-muted-foreground">
          輸入自然語言指令，讓 AI 生成或調整 NPC 與無主國家並重畫其領土。先預覽、確認後才套用。
          <span className="font-medium">玩家國家與其領土在任何情況下都完全不受影響。</span>
        </p>
      </div>

      <WorldSimSettingsCard
        settingsLoading={settingsLoading}
        settings={settings}
        savingField={savingField}
        saveSetting={saveSetting}
      />

      <AiJudgmentCard
        settingsLoading={settingsLoading}
        settings={settings}
        savingField={savingField}
        saveSetting={saveSetting}
        runningNow={runningNow}
        runJudgmentNow={runJudgmentNow}
        clearingCooldowns={clearingCooldowns}
        clearRegionCooldowns={clearRegionCooldowns}
        directive={directive}
        setDirective={setDirective}
      />

      <NpcAttitudesCard
        attLoading={attLoading}
        attNations={attNations}
        attDrafts={attDrafts}
        setAttDrafts={setAttDrafts}
        attSavingId={attSavingId}
        attGenId={attGenId}
        saveAttitude={saveAttitude}
        generateAttitude={generateAttitude}
      />

      <InstructionCard
        instruction={instruction}
        setInstruction={setInstruction}
        proposing={proposing}
        propose={propose}
      />

      {proposal && (
        <ProposalCard
          proposal={proposal}
          setProposal={setProposal}
          applying={applying}
          apply={apply}
        />
      )}

      <AuditsCard
        auditsLoading={auditsLoading}
        auditsError={auditsError}
        audits={audits}
      />

      <NpcChatGuardCard
        guardLoading={guardLoading}
        guardError={guardError}
        guardEvents={guardEvents}
        guardSummary={guardSummary}
        filterName={guardFilterName}
        onFilterNameChange={setGuardFilterName}
        onApplyFilter={(name) => {
          setGuardFilterName(name);
          void loadGuardEvents(name);
        }}
      />
    </div>
  );
}
