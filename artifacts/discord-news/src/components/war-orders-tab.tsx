import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Crosshair, Handshake, Loader2, MapPin, Swords } from "lucide-react";
import {
  useGetPlayerNation,
  useListDiplomacyWars,
  useGetMapPolitical,
  useListMapRegions,
  useInitiateWarCampaign,
  useGetMilitaryOverview,
  getListWarCampaignsQueryKey,
} from "@workspace/api-client-react";
import type { MapRegionEntry } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { WorldDistrictMap } from "@/components/world-district-map";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MY_FILL = "#b45309";
/** 己方持有但仍有無人空白可就地佔領的地區（比一般己方色偏黃綠，提示可操作）。 */
const MY_VOID_FILL = "#a16207";
const ENEMY_FILL = "#7f1d1d";
const TARGET_FILL = "#dc2626";
const TARGET_SELECTED_FILL = "#f97316";
const SEA_TARGET_FILL = "#0ea5e9";
const SEA_TARGET_SELECTED_FILL = "#38bdf8";
const UNOWNED_FILL = "#475569";
const UNOWNED_TARGET_FILL = "#059669";
const UNOWNED_TARGET_SELECTED_FILL = "#34d399";

/** 軍事指令分頁：兩段式地圖選取（己方出發地 → 相鄰敵區）發起戰役。 */
export function WarOrdersTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: nationData, isLoading: nationLoading } = useGetPlayerNation();
  const { data: warsData, isLoading: warsLoading } = useListDiplomacyWars();
  const { data: politicalData, isLoading: politicalLoading } = useGetMapPolitical();
  const { data: regionData, isLoading: regionsLoading } = useListMapRegions();
  const { data: overviewData } = useGetMilitaryOverview();

  const naval = overviewData?.navalLanding?.naval ?? false;
  const compass = overviewData?.navalLanding?.compass ?? false;
  const landingTroopCap = overviewData?.navalLanding?.troopCapacity ?? null;
  const landingReductionPct =
    overviewData?.navalLanding?.attackReductionPct ?? null;

  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [confirmUnownedOpen, setConfirmUnownedOpen] = useState(false);
  /** 目標地區有多個交戰敵國時，玩家選定的攻擊對象 id。 */
  const [selectedDefenderNationId, setSelectedDefenderNationId] = useState<
    string | null
  >(null);

  const myNationId = nationData?.nation?.id ?? null;

  const regionById = useMemo(() => {
    const m = new Map<number, MapRegionEntry>();
    for (const group of regionData?.macroRegions ?? []) {
      for (const r of group.regions) m.set(r.id, r);
    }
    return m;
  }, [regionData]);

  const regionByName = useMemo(() => {
    const m = new Map<string, MapRegionEntry>();
    for (const r of regionById.values()) m.set(r.name, r);
    return m;
  }, [regionById]);

  /** 與我交戰中的敵國（id → 名稱）。 */
  const enemyNations = useMemo(() => {
    const m = new Map<string, string>();
    if (!myNationId) return m;
    for (const w of warsData?.wars ?? []) {
      if (!w.involvesMe) continue;
      if (w.nationAId === myNationId) m.set(w.nationBId, w.nationBName);
      else if (w.nationBId === myNationId) m.set(w.nationAId, w.nationAName);
    }
    return m;
  }, [warsData, myNationId]);

  /** 我方控制的地區 id 集合。 */
  const myRegionIds = useMemo(() => {
    const s = new Set<number>();
    if (!myNationId) return s;
    for (const c of politicalData?.controls ?? []) {
      if (c.nationId === myNationId) s.add(c.regionId);
    }
    return s;
  }, [politicalData, myNationId]);

  /** 敵國控制的地區 → 該敵國 id（同區多敵國取比例最高者）。 */
  const enemyRegionOwner = useMemo(() => {
    const best = new Map<number, { nationId: string; percent: number }>();
    for (const c of politicalData?.controls ?? []) {
      if (!enemyNations.has(c.nationId)) continue;
      const prev = best.get(c.regionId);
      if (!prev || c.percent > prev.percent) {
        best.set(c.regionId, { nationId: c.nationId, percent: c.percent });
      }
    }
    return best;
  }, [politicalData, enemyNations]);

  /**
   * Task #353 — 敵國控制的地區 → 該地所有交戰敵國清單（比例高→低）。
   * 供同區多國混戰時列出所有可爭奪對象。
   */
  const enemyRegionOwners = useMemo(() => {
    const m = new Map<number, { nationId: string; percent: number }[]>();
    for (const c of politicalData?.controls ?? []) {
      if (!enemyNations.has(c.nationId)) continue;
      const list = m.get(c.regionId) ?? [];
      list.push({ nationId: c.nationId, percent: c.percent });
      m.set(c.regionId, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.percent - a.percent);
    return m;
  }, [politicalData, enemyNations]);

  /** 我方在各地區的控制比例（%）。 */
  const myControlByRegion = useMemo(() => {
    const m = new Map<number, number>();
    if (!myNationId) return m;
    for (const c of politicalData?.controls ?? []) {
      if (c.nationId === myNationId) m.set(c.regionId, c.percent);
    }
    return m;
  }, [politicalData, myNationId]);

  /** 各地區的完整控制列（比例高→低），供無人剩餘判定。 */
  const controlsByRegion = useMemo(() => {
    const m = new Map<number, { nationId: string; percent: number }[]>();
    for (const c of politicalData?.controls ?? []) {
      const list = m.get(c.regionId) ?? [];
      list.push({ nationId: c.nationId, percent: c.percent });
      m.set(c.regionId, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.percent - a.percent);
    return m;
  }, [politicalData]);

  /** 國家 id → 名稱（含 NPC／無主），供目標資訊顯示。 */
  const nationNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of politicalData?.nations ?? []) {
      if (n.name) m.set(n.id, n.name);
    }
    return m;
  }, [politicalData]);

  /** 無主國家 id 集合（未綁定玩家且非 NPC）。 */
  const unownedNationIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of politicalData?.nations ?? []) {
      if (n.isUnowned) s.add(n.id);
    }
    return s;
  }, [politicalData]);

  /**
   * 「無人領土」地區 id 集合：完全無控制列的空地，或最高比例控制者為
   * 無主國家的地區。排除己方地區與交戰敵國控制的地區（後者走一般戰役）。
   * 攻打這些地區會即時建國成 NPC 並反擊。
   */
  const unownedRegionIds = useMemo(() => {
    const s = new Set<number>();
    const dominant = new Map<number, { nationId: string; percent: number }>();
    for (const c of politicalData?.controls ?? []) {
      const prev = dominant.get(c.regionId);
      if (!prev || c.percent > prev.percent) {
        dominant.set(c.regionId, { nationId: c.nationId, percent: c.percent });
      }
    }
    for (const r of regionById.values()) {
      if (myRegionIds.has(r.id)) continue;
      if (enemyRegionOwner.has(r.id)) continue;
      const dom = dominant.get(r.id);
      if (!dom) s.add(r.id);
      else if (unownedNationIds.has(dom.nationId)) s.add(r.id);
    }
    return s;
  }, [politicalData, regionById, myRegionIds, enemyRegionOwner, unownedNationIds]);

  /**
   * Task #609 — 含空白的地區 id 集合：各國合計控制 < 100% 的所有地區。
   * 含己方持分地區（同區攻打空白用），不含 unownedRegionIds 的語意判定。
   */
  const voidRegionIds = useMemo(() => {
    const sumByRegion = new Map<number, number>();
    for (const c of politicalData?.controls ?? []) {
      sumByRegion.set(c.regionId, (sumByRegion.get(c.regionId) ?? 0) + c.percent);
    }
    const s = new Set<number>();
    for (const r of regionById.values()) {
      const total = sumByRegion.get(r.id) ?? 0;
      if (total < 100) s.add(r.id);
    }
    return s;
  }, [politicalData, regionById]);

  /**
   * 己方地區中「還有無人空白可就地佔領」者：各國合計 < 100% 且沒有交戰敵國持分。
   * 例：自己只持有 48%、其餘 52% 無人持有 → 遊戲仍視該區屬於自己，必須靠就地爭奪
   * 才拿得到剩餘空白。地圖以專屬色標示，並在面板給明確入口。
   */
  const myVoidSourceIds = useMemo(() => {
    const s = new Set<number>();
    for (const id of myRegionIds) {
      if (!voidRegionIds.has(id)) continue;
      const list = controlsByRegion.get(id) ?? [];
      if (list.some((c) => enemyNations.has(c.nationId))) continue;
      s.add(id);
    }
    return s;
  }, [myRegionIds, voidRegionIds, controlsByRegion, enemyNations]);

  const sourceRegion = sourceId != null ? (regionById.get(sourceId) ?? null) : null;
  const targetRegion = targetId != null ? (regionById.get(targetId) ?? null) : null;

  /** 出發地相鄰且由敵國控制的地區 id（一般陸戰目標）；若出發地本身也有敵國控制則納入（同區攻擊）。 */
  const validTargetIds = useMemo(() => {
    const s = new Set<number>();
    if (!sourceRegion) return s;
    for (const n of sourceRegion.neighbors) {
      if (enemyRegionOwner.has(n.id)) s.add(n.id);
    }
    // 出發地本身有交戰敵國 → 可就地同區攻擊
    if (enemyRegionOwner.has(sourceRegion.id)) s.add(sourceRegion.id);
    return s;
  }, [sourceRegion, enemyRegionOwner]);

  /** 目標地區所有控制列（比例高→低）。 */
  const targetRegionControls = useMemo(
    () => (targetId != null ? (controlsByRegion.get(targetId) ?? []) : []),
    [targetId, controlsByRegion],
  );

  /** 目標地區中的交戰敵國清單（比例高→低）。 */
  const targetEnemies = useMemo(
    () => targetRegionControls.filter((c) => enemyNations.has(c.nationId)),
    [targetRegionControls, enemyNations],
  );

  /** 海上登陸目標：近海（需海戰）＋ 跨洋（需指南針，無視距離）。 */
  const seaTargetIds = useMemo(() => {
    const s = new Set<number>();
    if (!sourceRegion) return s;
    const landIds = new Set(sourceRegion.neighbors.map((n) => n.id));
    const nearSeaIds = new Set(sourceRegion.seaNeighbors.map((n) => n.id));
    if (naval) {
      for (const id of nearSeaIds) {
        if (enemyRegionOwner.has(id)) s.add(id);
      }
    }
    if (compass) {
      for (const [regionId] of enemyRegionOwner) {
        if (regionId === sourceRegion.id) continue;
        if (landIds.has(regionId)) continue;
        s.add(regionId);
      }
    }
    return s;
  }, [sourceRegion, enemyRegionOwner, naval, compass]);

  /** 出發地相鄰的無人領土（陸戰目標）。Task #609：若出發地本身有空白且無交戰敵國，也納入（就地攻打空白）。 */
  const unownedLandTargetIds = useMemo(() => {
    const s = new Set<number>();
    if (!sourceRegion) return s;
    for (const n of sourceRegion.neighbors) {
      if (unownedRegionIds.has(n.id)) s.add(n.id);
    }
    // 出發地本身有空白（合計 < 100%）且無交戰敵國持分 → 可就地攻打空白
    const sourceControls = controlsByRegion.get(sourceRegion.id) ?? [];
    const sourceTotal = sourceControls.reduce((sum, c) => sum + c.percent, 0);
    const sourceHasEnemy = sourceControls.some((c) => enemyNations.has(c.nationId));
    if (sourceTotal < 100 && !sourceHasEnemy) s.add(sourceRegion.id);
    return s;
  }, [sourceRegion, unownedRegionIds, controlsByRegion, enemyNations]);

  /** 無人領土的海上登陸目標：近海（需海戰）＋ 跨洋（需指南針）。 */
  const unownedSeaTargetIds = useMemo(() => {
    const s = new Set<number>();
    if (!sourceRegion) return s;
    const landIds = new Set(sourceRegion.neighbors.map((n) => n.id));
    const nearSeaIds = new Set(sourceRegion.seaNeighbors.map((n) => n.id));
    if (naval) {
      for (const id of nearSeaIds) {
        if (unownedRegionIds.has(id)) s.add(id);
      }
    }
    if (compass) {
      for (const regionId of unownedRegionIds) {
        if (regionId === sourceRegion.id) continue;
        if (landIds.has(regionId)) continue;
        s.add(regionId);
      }
    }
    return s;
  }, [sourceRegion, unownedRegionIds, naval, compass]);

  /** 目前選定目標是否為海上登陸戰役（敵國或無人領土皆計）。 */
  const targetIsSeaLanding =
    targetId != null &&
    (seaTargetIds.has(targetId) || unownedSeaTargetIds.has(targetId));

  /** Task #609 — 目前選定目標是否有空白地帶（各國合計 < 100%）。 */
  const targetHasVoid = targetId != null && voidRegionIds.has(targetId);

  /** 目前選定目標是否為無人領土（發起後即時建國成 NPC）。 */
  const targetIsUnowned =
    targetId != null &&
    (unownedLandTargetIds.has(targetId) ||
      unownedSeaTargetIds.has(targetId) ||
      // Task #609 — 有空白且玩家明確選擇攻打空白（sentinel "void"）
      (targetHasVoid && selectedDefenderNationId === "void"));

  /**
   * 實際攻擊目標敵國 id：
   * - 無人領土 / 明確攻打空白：null（會即時建國）
   * - 單一敵國：自動選定
   * - 多敵國：依 selectedDefenderNationId 選定（null 時尚未選擇，主按鈕 disabled）
   */
  const effectiveDefenderNationId =
    selectedDefenderNationId === "void" || targetIsUnowned
      ? null
      : targetEnemies.length === 1
        ? targetEnemies[0].nationId
        : selectedDefenderNationId;

  const fills = useMemo(() => {
    const m = new Map<string, string>();
    for (const [regionId] of enemyRegionOwner) {
      const r = regionById.get(regionId);
      if (r) m.set(r.name, ENEMY_FILL);
    }
    for (const id of unownedRegionIds) {
      const r = regionById.get(id);
      if (r) m.set(r.name, UNOWNED_FILL);
    }
    for (const id of myRegionIds) {
      const r = regionById.get(id);
      if (!r) continue;
      m.set(r.name, myVoidSourceIds.has(id) ? MY_VOID_FILL : MY_FILL);
    }
    for (const id of seaTargetIds) {
      if (validTargetIds.has(id)) continue;
      const r = regionById.get(id);
      if (r)
        m.set(
          r.name,
          id === targetId ? SEA_TARGET_SELECTED_FILL : SEA_TARGET_FILL,
        );
    }
    for (const id of validTargetIds) {
      const r = regionById.get(id);
      if (r) m.set(r.name, id === targetId ? TARGET_SELECTED_FILL : TARGET_FILL);
    }
    for (const id of unownedSeaTargetIds) {
      if (unownedLandTargetIds.has(id)) continue;
      const r = regionById.get(id);
      if (r)
        m.set(
          r.name,
          id === targetId
            ? UNOWNED_TARGET_SELECTED_FILL
            : UNOWNED_TARGET_FILL,
        );
    }
    for (const id of unownedLandTargetIds) {
      // Task #609 — 出發地本身在 unownedLandTargetIds（有空白無敵）時，未選為目標前
      // 保持己方顏色（amber），只有選為目標後才改顯示為空白目標（green）。
      if (myRegionIds.has(id) && id !== targetId) continue;
      const r = regionById.get(id);
      if (r)
        m.set(
          r.name,
          id === targetId
            ? UNOWNED_TARGET_SELECTED_FILL
            : UNOWNED_TARGET_FILL,
        );
    }
    return m;
  }, [
    enemyRegionOwner,
    unownedRegionIds,
    myRegionIds,
    myVoidSourceIds,
    sourceId,
    validTargetIds,
    seaTargetIds,
    unownedLandTargetIds,
    unownedSeaTargetIds,
    targetId,
    regionById,
  ]);

  const targetNames = useMemo(() => {
    const s = new Set<string>();
    for (const id of validTargetIds) {
      const r = regionById.get(id);
      if (r) s.add(r.name);
    }
    for (const id of seaTargetIds) {
      const r = regionById.get(id);
      if (r) s.add(r.name);
    }
    for (const id of unownedLandTargetIds) {
      const r = regionById.get(id);
      if (r) s.add(r.name);
    }
    for (const id of unownedSeaTargetIds) {
      const r = regionById.get(id);
      if (r) s.add(r.name);
    }
    return s;
  }, [
    validTargetIds,
    seaTargetIds,
    unownedLandTargetIds,
    unownedSeaTargetIds,
    regionById,
  ]);

  const initiateMutation = useInitiateWarCampaign({
    mutation: {
      onSuccess: (campaign) => {
        queryClient.invalidateQueries({ queryKey: getListWarCampaignsQueryKey() });
        toast({
          title: "戰役已發起！",
          description: `已對 ${campaign.opponentName} 的 ${campaign.defenderRegionName} 發起進攻，前往戰情室部署軍團。`,
        });
        navigate(`/game/military/war/${campaign.id}`);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "發起戰役失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  const handleSelect = (regionName: string) => {
    const r = regionByName.get(regionName);
    if (!r) return;
    if (myRegionIds.has(r.id)) {
      // 出發地已設定 + 點擊的是出發地本身（有敵國或有空白）→ 設為目標（同區攻擊/就地空白爭奪）
      if (
        sourceRegion &&
        r.id === sourceRegion.id &&
        (validTargetIds.has(r.id) || unownedLandTargetIds.has(r.id))
      ) {
        setTargetId(r.id);
        setSelectedDefenderNationId(null);
        return;
      }
      setSourceId(r.id);
      setTargetId(null);
      setSelectedDefenderNationId(null);
      return;
    }
    if (
      sourceRegion &&
      (validTargetIds.has(r.id) ||
        seaTargetIds.has(r.id) ||
        unownedLandTargetIds.has(r.id) ||
        unownedSeaTargetIds.has(r.id))
    ) {
      setTargetId(r.id);
      setSelectedDefenderNationId(null);
      return;
    }
    if (enemyRegionOwner.has(r.id) || unownedRegionIds.has(r.id)) {
      toast({
        title: "無法進攻這個地區",
        description: sourceRegion
          ? "目標必須與出發地區陸地相鄰，或在解鎖海戰／指南針後進行海上登陸。"
          : "請先選擇一塊己方控制的地區作為出發地。",
      });
      return;
    }
    toast({
      title: "無法選擇這個地區",
      description:
        "出發地必須是己方控制的地區（琥珀色）；目標可為交戰敵國的相鄰地區（紅色）或無人領土（綠色）。",
    });
  };

  const busy = nationLoading || warsLoading || politicalLoading || regionsLoading;

  if (busy) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur">
        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
      </div>
    );
  }

  if (enemyNations.size === 0 && unownedRegionIds.size === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur"
        data-testid="panel-no-wars"
      >
        <div className="max-w-md text-center">
          <Handshake className="mx-auto mb-4 h-12 w-12 text-white/30" />
          <h2 className="mb-2 font-serif text-xl font-bold text-white/80">
            目前沒有可進攻的目標
          </h2>
          <p className="mb-4 text-sm text-white/50">
            發起戰役前，必須先與目標國家處於戰爭狀態，或攻打地圖上的無人領土。請先前往外交介面宣戰。
          </p>
          <Link
            href="/game/diplomacy"
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300/50 bg-amber-500/20 px-4 py-2 text-sm font-bold text-amber-100 transition hover:bg-amber-500/30"
            data-testid="link-go-diplomacy"
          >
            <Handshake className="h-4 w-4" />
            前往外交介面
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      {/* 地圖兩段式選取 */}
      <div className="rounded-2xl border border-white/15 bg-black/55 p-3 backdrop-blur">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold">
          <span className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 text-amber-300" />
            選擇進攻路線
          </span>
          <span className="flex items-center gap-1 text-xs font-normal text-white/55">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: MY_FILL }} />
            己方地區
          </span>
          {myVoidSourceIds.size > 0 ? (
            <span className="flex items-center gap-1 text-xs font-normal text-white/55">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: MY_VOID_FILL }} />
              己方（尚有空白可佔領）
            </span>
          ) : null}
          <span className="flex items-center gap-1 text-xs font-normal text-white/55">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: ENEMY_FILL }} />
            交戰敵國
          </span>
          <span className="flex items-center gap-1 text-xs font-normal text-white/55">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: TARGET_FILL }} />
            可進攻目標
          </span>
          <span className="flex items-center gap-1 text-xs font-normal text-white/55">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: UNOWNED_FILL }} />
            無人領土
          </span>
          <span className="flex items-center gap-1 text-xs font-normal text-white/55">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: UNOWNED_TARGET_FILL }} />
            可佔領目標
          </span>
          {naval ? (
            <span className="flex items-center gap-1 text-xs font-normal text-white/55">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SEA_TARGET_FILL }} />
              海上登陸目標
            </span>
          ) : null}
        </div>
        <WorldDistrictMap
          selectedName={sourceRegion?.name ?? null}
          neighborNames={targetNames}
          onSelect={handleSelect}
          fills={fills}
        />
      </div>

      {/* 發起面板 */}
      <div className="space-y-4 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Crosshair className="h-4 w-4 text-red-300" />
          發起戰役
        </div>

        <div className="space-y-2 text-sm">
          <div data-testid="text-war-source">
            <span className="text-white/55">出發地區：</span>
            {sourceRegion ? (
              <span className="font-bold text-amber-200">{sourceRegion.name}</span>
            ) : (
              <span className="text-white/45">請在地圖上點選己方地區</span>
            )}
          </div>
          <div data-testid="text-war-target">
            <span className="text-white/55">目標地區：</span>
            {targetRegion ? (
              <span className="font-bold text-red-300">
                {targetRegion.name}
                {targetId === sourceId ? (
                  <span className="ml-1.5 inline-block rounded bg-amber-500/25 px-1.5 py-0.5 text-xs font-normal text-amber-200">
                    同區
                  </span>
                ) : null}
                {targetIsSeaLanding ? (
                  <span
                    className="ml-1.5 inline-block rounded bg-sky-500/25 px-1.5 py-0.5 text-xs font-normal text-sky-200"
                    data-testid="badge-sea-landing"
                  >
                    海上登陸
                  </span>
                ) : null}
              </span>
            ) : sourceRegion ? (
              <span className="text-white/45">
                {targetNames.size > 0
                  ? "請點選高亮的敵區，或再點一次己方地區（若有敵國在內，或該區還有無人空白可佔領）"
                  : "此出發地沒有可進攻的敵國地區，請換一塊出發地"}
              </span>
            ) : (
              <span className="text-white/45">先選擇出發地區</span>
            )}
          </div>
        </div>

        {/* 就地佔領入口：出發地還有無人空白（例如自己只持有 48%、其餘 52% 無人持有）時，
            直接給明確按鈕，不用玩家猜「再點一次己方地區」。 */}
        {sourceRegion && myVoidSourceIds.has(sourceRegion.id) && targetId !== sourceRegion.id ? (
          <div
            className="space-y-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-100/90"
            data-testid="panel-claim-void-here"
          >
            <div className="font-semibold text-emerald-200">
              「{sourceRegion.name}」還有{" "}
              {100 - (controlsByRegion.get(sourceRegion.id) ?? []).reduce((a, c) => a + c.percent, 0)}
              % 無人持有的空白
            </div>
            <div>
              你目前只持有 {myControlByRegion.get(sourceRegion.id) ?? 0}%。發起就地爭奪會在此建立一個 AI 控制的
              NPC 國家佔據剩餘空白並反擊，打贏後即可取得整塊領土。
            </div>
            <button
              onClick={() => {
                setTargetId(sourceRegion.id);
                setSelectedDefenderNationId(null);
              }}
              className="w-full rounded border border-emerald-400/50 bg-emerald-600/30 px-3 py-1.5 font-bold text-emerald-100 transition hover:bg-emerald-600/45"
              data-testid="button-claim-void-here"
            >
              就地爭奪剩餘空白
            </button>
          </div>
        ) : null}

                {/* 目標地區控制情況：選定目標後顯示（Task #609：含空白地帶時也顯示，不因 void 選擇而隱藏） */}
        {targetRegion && (!targetIsUnowned || targetHasVoid) ? (
          <div
            className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-relaxed text-white/70"
            data-testid="panel-target-controls"
          >
            <div className="font-semibold text-white/85">
              「{targetRegion.name}」控制情況
            </div>
            {targetRegionControls.length === 0 ? (
              <div className="text-white/45">尚無控制資料</div>
            ) : (
              <div className="space-y-1">
                {targetRegionControls.map((c) => {
                  const name = nationNameById.get(c.nationId) ?? c.nationId;
                  const isEnemy = enemyNations.has(c.nationId);
                  const isMine = c.nationId === myNationId;
                  const isChosen = effectiveDefenderNationId === c.nationId;
                  return (
                    <div
                      key={c.nationId}
                      className="flex items-center justify-between gap-2"
                    >
                      <span
                        className={
                          isMine
                            ? "text-amber-200"
                            : isEnemy
                              ? "text-red-300"
                              : "text-white/55"
                        }
                      >
                        {name}
                        <span className="ml-1.5 font-bold">{c.percent}%</span>
                      </span>
                      {isEnemy && (targetEnemies.length > 1 || targetHasVoid) ? (
                        <button
                          onClick={() => setSelectedDefenderNationId(c.nationId)}
                          className={`rounded border px-2 py-0.5 text-xs transition ${
                            isChosen
                              ? "border-red-400 bg-red-500/30 font-bold text-red-100"
                              : "border-red-400/30 bg-red-500/10 text-red-200/80 hover:bg-red-500/20"
                          }`}
                          data-testid={`button-select-defender-${c.nationId}`}
                        >
                          {isChosen ? "✓ 選定" : "攻擊"}
                        </button>
                      ) : isEnemy ? (
                        <span className="rounded border border-red-400/40 bg-red-500/15 px-2 py-0.5 text-xs text-red-200">
                          攻擊目標
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                {/* Task #609 — 空白地帶選項：有其餘空白時顯示 */}
                {targetHasVoid ? (() => {
                  const voidPct = 100 - targetRegionControls.reduce((s, c) => s + c.percent, 0);
                  const isVoidChosen = selectedDefenderNationId === "void";
                  return (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-emerald-300">
                        無人地帶
                        <span className="ml-1.5 font-bold">{voidPct}%</span>
                      </span>
                      {targetEnemies.length > 0 ? (
                        <button
                          onClick={() =>
                            setSelectedDefenderNationId(
                              isVoidChosen ? null : "void",
                            )
                          }
                          className={`rounded border px-2 py-0.5 text-xs transition ${
                            isVoidChosen
                              ? "border-emerald-400 bg-emerald-500/30 font-bold text-emerald-100"
                              : "border-emerald-400/30 bg-emerald-500/10 text-emerald-200/80 hover:bg-emerald-500/20"
                          }`}
                          data-testid="button-select-void"
                        >
                          {isVoidChosen ? "✓ 選定" : "攻擊空白"}
                        </button>
                      ) : null}
                    </div>
                  );
                })() : null}
              </div>
            )}
            {targetEnemies.length > 1 && !effectiveDefenderNationId && selectedDefenderNationId !== "void" ? (
              <div className="text-xs text-amber-300/80">
                此地區有多個交戰敵國，請選擇攻擊對象後再發起戰役。
              </div>
            ) : null}
          </div>
        ) : null}

        {targetIsSeaLanding ? (
          <div
            className="rounded-lg border border-sky-400/30 bg-sky-500/10 p-3 text-xs leading-relaxed text-sky-100/80"
            data-testid="panel-sea-landing"
          >
            <div className="mb-1 font-semibold text-sky-200">海上登陸戰役</div>
            <div>
              登陸作戰會大幅降低攻擊力，並限制可投入兵力上限。
              {compass ? "（已解鎖指南針：可跨洋登陸，兵力上限提升）" : "（僅限近海相鄰地區）"}
            </div>
            {landingReductionPct != null ? (
              <div className="mt-1">
                攻擊力減損：
                <span className="font-bold text-sky-200">{landingReductionPct}%</span>
              </div>
            ) : null}
            {landingTroopCap != null ? (
              <div>
                可投入兵力上限：
                <span className="font-bold text-sky-200">
                  {landingTroopCap.toLocaleString("zh-TW")}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {targetIsUnowned ? (
          <div
            className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-100/80"
            data-testid="panel-unowned-target"
          >
            <div className="mb-1 font-semibold text-emerald-200">
              進攻無人領土
            </div>
            <div>
              這是一塊無人領土。發起進攻會立即在此建立一個 AI
              控制的 NPC 國家，並由其反擊；該國會永久留在世界上。
            </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-relaxed text-white/60">
          <div className="mb-1 font-semibold text-white/75">交戰中的敵國</div>
          {enemyNations.size > 0 ? (
            [...enemyNations.values()].map((name) => (
              <span
                key={name}
                className="mr-1.5 inline-block rounded bg-red-500/20 px-2 py-0.5 text-red-200"
              >
                {name}
              </span>
            ))
          ) : (
            <span className="text-white/45">
              目前沒有交戰中的國家，可直接攻打地圖上的無人領土（綠色）。
            </span>
          )}
          <div className="mt-2">
            發起後由 AI 生成戰場地理敘述，每個結算週期（預設 24
            小時）自動推演一次戰局。同一對地區交戰結束後有冷卻時間，冷卻中無法再次發起。
          </div>
        </div>

        <button
          onClick={() => {
            if (sourceId == null || targetId == null) return;
            if (targetIsUnowned) {
              setConfirmUnownedOpen(true);
              return;
            }
            initiateMutation.mutate({
              data: {
                attackerRegionId: sourceId,
                defenderRegionId: targetId,
                ...(effectiveDefenderNationId != null
                  ? { defenderNationId: effectiveDefenderNationId }
                  : {}),
              },
            });
          }}
          disabled={
            sourceId == null ||
            targetId == null ||
            initiateMutation.isPending ||
            // 多敵國且未選目標（void 不算未選）
            (!targetIsUnowned &&
              selectedDefenderNationId !== "void" &&
              targetEnemies.length > 1 &&
              !effectiveDefenderNationId)
          }
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-400/50 bg-red-600/30 px-4 py-2.5 font-serif text-sm font-bold text-red-100 transition hover:bg-red-600/45 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="button-initiate-campaign"
        >
          {initiateMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Swords className="h-4 w-4" />
          )}
          {targetRegion && sourceRegion
            ? targetId === sourceId
              ? `在「${sourceRegion.name}」就地爭奪`
              : `從 ${sourceRegion.name} 進攻 ${targetRegion.name}`
            : "發起戰役"}
        </button>
      </div>

      <AlertDialog
        open={confirmUnownedOpen}
        onOpenChange={setConfirmUnownedOpen}
      >
        <AlertDialogContent data-testid="dialog-confirm-unowned">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedDefenderNationId === "void" ? "進攻空白地帶？" : "進攻無人領土？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedDefenderNationId === "void" && targetRegion
                ? `「${targetRegion.name}」有部分無人地帶。發起進攻會立即在此建立一個由 AI 控制的 NPC 國家佔據剩餘空白，並由其反擊；該國會永久留在世界上。確定要進攻嗎？`
                : targetRegion
                  ? `「${targetRegion.name}」目前無人統治。發起進攻會立即在此建立一個由 AI 控制的 NPC 國家並反擊，該國會永久留在世界上。確定要進攻嗎？`
                  : "發起進攻會立即在此建立一個由 AI 控制的 NPC 國家並反擊。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-unowned">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (sourceId == null || targetId == null) return;
                initiateMutation.mutate({
                  data: {
                    attackerRegionId: sourceId,
                    defenderRegionId: targetId,
                    // Task #609 — void 路徑傳 null 告知後端強制攻打空白
                    ...(selectedDefenderNationId === "void"
                      ? { defenderNationId: null }
                      : {}),
                  },
                });
              }}
              data-testid="button-confirm-unowned"
            >
              確定進攻
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
