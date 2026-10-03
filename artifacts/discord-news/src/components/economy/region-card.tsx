import {
  Building2,
  Landmark,
  Loader2,
  Map as MapIcon,
  Shield,
  Trash2,
  TrendingUp,
} from "lucide-react";
import type {
  EconomyRegion,
  AvailableBuilding,
  EconomyCityWall,
  WallTierInfo,
  UpgradeCityWallRequestTier,
} from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";
import { RegionBuildingsBlock } from "@/components/world-map/region-buildings-block";

export function RegionCard({
  region,
  slotsPerCity,
  availableBuildings,
  cityWallEnabled,
  wallTiers,
  demolishPending,
  upgradeWallPending,
  money,
  investPending,
  myNationId,
  onInvest,
  onBuildSlot,
  onDemolish,
  onUpgradeWall,
}: {
  region: EconomyRegion;
  slotsPerCity: number;
  availableBuildings: AvailableBuilding[];
  cityWallEnabled: boolean;
  wallTiers: WallTierInfo[];
  demolishPending: boolean;
  upgradeWallPending: boolean;
  money: number;
  investPending: boolean;
  myNationId: string | null;
  onInvest: (regionId: number) => void;
  onBuildSlot: (cityId: number, cityName: string) => void;
  onDemolish: (id: number) => void;
  onUpgradeWall: (cityId: number, tier: UpgradeCityWallRequestTier) => void;
}) {
  const buildingByType = new Map(availableBuildings.map((b) => [b.type, b]));
  return (
    <section
      className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid={`region-card-${region.regionId}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-sky-300" />
          <h3 className="font-serif text-base font-bold text-white/90">{region.name}</h3>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
            {region.macroRegion}
          </span>
        </div>
        <span className="shrink-0 text-[11px] text-white/50">掌控 {region.percent}%</span>
      </div>

      {region.investment && (
        <div
          className="mb-3 rounded-xl border border-white/10 bg-black/25 p-3"
          data-testid={`region-investment-${region.regionId}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] text-white/70">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-300" />
              <span className="font-semibold text-white/85">生產力投資</span>
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">
                生產素質 {region.investment.effectiveProductivity}
                {region.investment.investmentBonus > 0 && (
                  <span className="text-emerald-300/80">
                    （含投資 +{region.investment.investmentBonus}）
                  </span>
                )}
              </span>
            </div>
            <span className="text-[10px] tabular-nums text-white/45">
              全球平均 {region.investment.avgEffectiveProductivity} · 費用倍率 ×
              {region.investment.costMultiplier}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] leading-relaxed text-white/50">
              投資一次 → 全地區生產素質 +1（跨時代永久）。費用 = 地區人口 ×
              倍率（高於全球平均越多越貴）。
            </span>
            <button
              onClick={() => onInvest(region.regionId)}
              disabled={investPending || money < region.investment.nextInvestCost}
              className="shrink-0 rounded-md border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                money < region.investment.nextInvestCost
                  ? "金錢不足"
                  : "投資使此地區生產素質 +1"
              }
              data-testid={`button-invest-${region.regionId}`}
            >
              {investPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>投資（{formatBigNumber(region.investment.nextInvestCost)} 金錢）</>
              )}
            </button>
          </div>
        </div>
      )}

      {region.cities.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-6 text-center text-xs text-white/45">
          此地區暫無城市，沒有可興建的建築槽。
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {region.cities.map((city) => {
            const emptySlots = Math.max(0, slotsPerCity - city.slotsUsed);
            return (
              <li
                key={city.id}
                className="rounded-xl border border-white/10 bg-white/5 p-3"
                data-testid={`city-${city.id}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5 text-amber-200" />
                    <span className="text-sm font-bold">{city.name}</span>
                  </div>
                  <span className="text-[10px] text-white/45">
                    建築槽 {city.slotsUsed} / {slotsPerCity}
                  </span>
                </div>
                <div
                  className="flex flex-wrap gap-1.5"
                  data-testid={`city-slots-${city.id}`}
                >
                  {city.buildings.map((b) => {
                    const def = buildingByType.get(b.type);
                    return (
                      <button
                        key={b.id}
                        onClick={() => onDemolish(b.id)}
                        disabled={demolishPending}
                        className="group flex h-8 items-center gap-1 rounded-md border border-amber-300/40 bg-amber-500/15 px-2 text-amber-100 transition hover:border-red-400/60 hover:bg-red-500/20 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={`${b.name}${def ? ` — 維護 ${def.upkeep}/回合。點擊拆除（不退款）` : "（點擊拆除）"}`}
                        data-testid={`slot-building-${b.id}`}
                      >
                        <Building2 className="h-3.5 w-3.5 group-hover:hidden" />
                        <Trash2 className="hidden h-3.5 w-3.5 group-hover:block" />
                        <span className="text-[11px] font-semibold">
                          {b.name}
                        </span>
                      </button>
                    );
                  })}
                  {Array.from({ length: emptySlots }).map((_, i) => (
                    <button
                      key={`empty-${i}`}
                      onClick={() => onBuildSlot(city.id, city.name)}
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-white/20 bg-black/30 text-white/25 transition hover:border-amber-300/60 hover:bg-amber-500/10 hover:text-amber-200"
                      title="空建築槽 — 點擊建造"
                      aria-label="空建築槽，點擊建造"
                      data-testid={`slot-build-${city.id}-${i}`}
                    >
                      <Building2 className="h-4 w-4" />
                    </button>
                  ))}
                  {slotsPerCity === 0 && (
                    <span className="text-[10px] text-white/40">
                      無可用建築槽（需社會關鍵技術）
                    </span>
                  )}
                </div>
                <CityWallControl
                  wall={city.wall}
                  cityWallEnabled={cityWallEnabled}
                  wallTiers={wallTiers}
                  pending={upgradeWallPending}
                  onUpgrade={(tier) => onUpgradeWall(city.id, tier)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {/* Task #471 — 資源建築（伐木場／礦場）也能直接在經濟頁地區卡操作；
          與世界地圖地區詳情共用同一組件與 query keys。 */}
      <RegionBuildingsBlock
        regionId={region.regionId}
        myNationId={myNationId}
        variant="dark"
      />
    </section>
  );
}

/**
 * 城牆狀態＋升級：顯示目前階級、耐久上限、守軍防禦加成，
 * 並提供升級到下一階的按鈕（僅升級、花費金錢、不可降級）。
 * Task #150。
 */
function CityWallControl({
  wall,
  cityWallEnabled,
  wallTiers,
  pending,
  onUpgrade,
}: {
  wall: EconomyCityWall;
  cityWallEnabled: boolean;
  wallTiers: WallTierInfo[];
  pending: boolean;
  onUpgrade: (tier: UpgradeCityWallRequestTier) => void;
}) {
  const atMax = wall.nextTier == null;
  return (
    <div
      className="mt-2 rounded-lg border border-white/10 bg-black/25 p-2"
      data-testid="city-wall"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] text-white/70">
          <Shield className="h-3.5 w-3.5 text-amber-200" />
          <span className="font-semibold text-white/85">城牆</span>
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
            {wall.tierLabel}
          </span>
        </div>
        <span className="text-[10px] tabular-nums text-white/45">
          耐久 {wall.maxDurability.toLocaleString("en-US")} · 守軍防禦 +
          {wall.defenseBonusPct}%
        </span>
      </div>
      {!cityWallEnabled ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-white/40">
          升級城牆需先由生產科技解鎖（風車技術），目前僅有預設木牆。
        </p>
      ) : atMax ? (
        <p className="mt-1.5 text-[10px] text-emerald-300/70">已達最高城牆階級。</p>
      ) : (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[10px] text-white/50">
            下一階：
            <span className="font-semibold text-white/70">
              {wall.nextTierLabel}
            </span>
            {wall.upgradeCost != null && (
              <span className="ml-1 tabular-nums">
                （{formatBigNumber(wall.upgradeCost)} 金錢）
              </span>
            )}
            {!wall.nextTierUnlocked && (
              <span className="ml-1 text-amber-300/70">需更高生產科技/時代</span>
            )}
          </span>
          <button
            onClick={() => {
              if (wall.nextTier && wall.nextTier !== "wood")
                onUpgrade(wall.nextTier);
            }}
            disabled={!wall.canUpgrade || pending}
            className="shrink-0 rounded-md border border-amber-300/40 bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              wall.nextTierUnlocked
                ? `升級為${wall.nextTierLabel}（花費金錢，不可降級）`
                : "下一階城牆尚未由生產科技/時代解鎖"
            }
            data-testid="button-upgrade-wall"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "升級"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
