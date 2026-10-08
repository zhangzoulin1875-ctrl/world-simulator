import React, { useEffect, useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry } from "geojson";
import { ZoomIn, ZoomOut, Maximize, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { computeFrontPath, warFrontLabel, type WarFront } from "@/lib/warFronts";

const VIEW_W = 980;
const VIEW_H = 500;
const MIN_K = 1;
const MAX_K = 14;

/** 標籤字級（viewBox 單位，除以縮放 k 後維持螢幕上固定大小）。 */
const LABEL_FONT = 17;
const VALUE_FONT = 15;
/** 擁擠抑制：地區面積 × k² 需超過此值才顯示標示（避免縮小時擠成一團）。 */
const LABEL_MIN_SCREEN_AREA = 3600;

/** 城市點與標籤（螢幕固定大小，除以 k）。 */
const CITY_DOT_R = 2.4;
const CITY_FONT = 9;

interface DistrictProps {
  district: string;
}

interface DistrictPath {
  name: string;
  d: string;
  /** 標示定位點（geoPath centroid，viewBox 座標）。 */
  cx: number;
  cy: number;
  /** 投影後面積（viewBox 平方單位），用於擁擠抑制。 */
  area: number;
}

export interface MapCityPoint {
  name: string;
  lat: number;
  lng: number;
  regionName: string;
  /** 主控國國名（無主 = null）；提供時於城市名稱下方顯示 👑 國名，供所有玩家可見。 */
  ownerNationName?: string | null;
}

export interface MapLegend {
  title: string;
  /** CSS 漸層起訖色。 */
  from: string;
  to: string;
  minLabel: string;
  maxLabel: string;
}

/** 政治視圖用：以色塊＋名稱列出的分類圖例（取代數值漸層）。 */
export interface MapSwatchLegend {
  title: string;
  items: readonly { color: string; label: string }[];
  /** 全部項目皆無時顯示的空狀態文字。 */
  emptyText?: string;
}

interface WorldDistrictMapProps {
  selectedName: string | null;
  neighborNames: ReadonlySet<string>;
  onSelect: (name: string) => void;
  /** 數據視圖：地區名稱 → 填色。null/undefined = 一般視圖。 */
  fills?: ReadonlyMap<string, string> | null;
  /** 顯示地區名稱標籤。 */
  showLabels?: boolean;
  /** 顯示目前圖層數值（需 fills 存在）。 */
  showValues?: boolean;
  /** 地區名稱 → 已格式化的數值字串。 */
  valueByName?: ReadonlyMap<string, string> | null;
  /** 數據視圖的色階圖例。 */
  legend?: MapLegend | null;
  /** 分類（國家清單）圖例；與 legend 擇一使用。 */
  swatchLegend?: MapSwatchLegend | null;
  /** 歷史城市點位（lat/lng，內部投影成地圖座標）。 */
  cities?: readonly MapCityPoint[] | null;
  /** 顯示城市點與名稱。 */
  showCities?: boolean;
  /**
   * 政治視圖：地區名稱 → 主控國的國旗與國名。提供時（政治視圖）於各地區
   * 中心渲染小國旗＋國名（沿用擁擠抑制），與圖層標籤/數值獨立、預設可見。
   * flagUrl 為 null 時只顯示國名，不破圖。
   */
  regionFlags?: ReadonlyMap<string, { flagUrl: string | null; label: string }> | null;
  /**
   * 進行中戰役的地區名稱集合。提供時於各交戰地區的中心疊加 ⚔ 圖示。
   */
  activeWarRegionNames?: ReadonlySet<string> | null;
  /**
   * 進行中戰役的戰線（攻方地區 → 守方地區）。提供時於 ⚔ 下方畫紅色箭頭，
   * 縮放到一定程度後在箭頭旁顯示「攻方國 → 守方國」。
   */
  warFronts?: readonly WarFront[] | null;
  /**
   * 已選取的地區名稱集合（建國選地區）。提供時於各選取地區的中心疊加 ✓ 圖示。
   */
  checkmarkRegionNames?: ReadonlySet<string> | null;
}

/** 目前渲染方式下、viewBox 內實際可見的視窗（考量 preserveAspectRatio meet/slice）。 */
interface ViewWindow {
  cx: number;
  cy: number;
  vw: number;
  vh: number;
}

/**
 * 依 SVG 實際渲染尺寸與 meet/slice 推算可見 viewBox 視窗。
 * meet（桌面 w-full h-auto，長寬比與 viewBox 相同）→ 視窗即整個 viewBox，行為與舊版一致；
 * slice（手機填滿較高容器）→ 視窗較窄，據此計算平移邊界，讓被裁切的區域仍可拖曳看到。
 */
function getViewWindow(
  rect: { width: number; height: number },
  slice: boolean,
): ViewWindow {
  if (!rect.width || !rect.height) {
    return { cx: 0, cy: 0, vw: VIEW_W, vh: VIEW_H };
  }
  const s = slice
    ? Math.max(rect.width / VIEW_W, rect.height / VIEW_H)
    : Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
  const vw = rect.width / s;
  const vh = rect.height / s;
  return { cx: (VIEW_W - vw) / 2, cy: (VIEW_H - vh) / 2, vw, vh };
}

function clampTransform(
  k: number,
  x: number,
  y: number,
  win: ViewWindow = { cx: 0, cy: 0, vw: VIEW_W, vh: VIEW_H },
) {
  const minX = win.cx + win.vw - k * VIEW_W;
  const minY = win.cy + win.vh - k * VIEW_H;
  return {
    k,
    x: Math.min(win.cx, Math.max(minX, x)),
    y: Math.min(win.cy, Math.max(minY, y)),
  };
}

export function WorldDistrictMap({
  selectedName,
  neighborNames,
  onSelect,
  fills = null,
  showLabels = false,
  showValues = false,
  valueByName = null,
  legend = null,
  swatchLegend = null,
  cities = null,
  showCities = false,
  regionFlags = null,
  activeWarRegionNames = null,
  warFronts = null,
  checkmarkRegionNames = null,
}: WorldDistrictMapProps) {
  const isMobile = useIsMobile();
  const [paths, setPaths] = useState<DistrictPath[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });

  const svgRef = useRef<SVGSVGElement | null>(null);
  // 手機以 slice 填滿較高容器，桌面維持 meet 自動比例；供事件監聽器讀取最新值。
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    captured: boolean;
  } | null>(null);
  // 目前落在地圖上的所有指標（觸控點）；兩指以上啟用捏合縮放。
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // 捏合開始時的狀態快照：初始兩指距離、當時的 transform 與中點（viewBox 座標）。
  const pinchRef = useRef<{
    startDist: number;
    k0: number;
    x0: number;
    y0: number;
    midViewX: number;
    midViewY: number;
  } | null>(null);
  // 持續存活到下一次 pointerdown，click 事件（發生在 pointerup 之後）才能正確判斷是否為拖曳
  const movedRef = useRef(false);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  /** lat/lng → viewBox 座標（載入圖資後設定；city 點位投影用）。 */
  const projectRef = useRef<((lng: number, lat: number) => [number, number] | null) | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}world-districts.topo.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Topology<{ districts: GeometryCollection<DistrictProps> }>>;
      })
      .then((topo) => {
        if (cancelled) return;
        const fc = feature(topo, topo.objects.districts) as FeatureCollection<
          Geometry,
          DistrictProps
        >;
        const projection = geoNaturalEarth1().fitSize([VIEW_W, VIEW_H], fc);
        const pathGen = geoPath(projection);
        projectRef.current = (lng, lat) => projection([lng, lat]);
        setPaths(
          fc.features.map((f) => {
            const [cx, cy] = pathGen.centroid(f);
            return {
              name: f.properties.district,
              d: pathGen(f) ?? "",
              cx: Number.isFinite(cx) ? cx : -9999,
              cy: Number.isFinite(cy) ? cy : -9999,
              area: pathGen.area(f),
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 滾輪縮放需要 non-passive listener 才能 preventDefault（避免頁面跟著捲動）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const win = getViewWindow(rect, mobileRef.current);
      const vx = win.cx + ((e.clientX - rect.left) / rect.width) * win.vw;
      const vy = win.cy + ((e.clientY - rect.top) / rect.height) * win.vh;
      const { k, x, y } = transformRef.current;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const nk = Math.min(MAX_K, Math.max(MIN_K, k * factor));
      if (nk === k) return;
      const wx = (vx - x) / k;
      const wy = (vy - y) / k;
      setTransform(clampTransform(nk, vx - wx * nk, vy - wy * nk, win));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [paths]);

  // meet/slice 切換（例如旋轉螢幕或跨越斷點）後，把現有平移重新限制在新視窗內。
  useEffect(() => {
    if (!paths) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const win = getViewWindow(rect, isMobile);
    setTransform((t) => clampTransform(t.k, t.x, t.y, win));
  }, [isMobile, paths]);

  /** 目前 SVG 渲染尺寸換算的可見 viewBox 視窗（含 meet/slice 差異）。 */
  const currentWindow = (): ViewWindow => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { cx: 0, cy: 0, vw: VIEW_W, vh: VIEW_H };
    return getViewWindow(rect, mobileRef.current);
  };

  const zoomBy = (factor: number) => {
    const { k, x, y } = transformRef.current;
    const nk = Math.min(MAX_K, Math.max(MIN_K, k * factor));
    if (nk === k) return;
    const win = currentWindow();
    const cx = win.cx + win.vw / 2;
    const cy = win.cy + win.vh / 2;
    const wx = (cx - x) / k;
    const wy = (cy - y) / k;
    setTransform(clampTransform(nk, cx - wx * nk, cy - wy * nk, win));
  };

  /** client 座標 → viewBox 座標（考量 meet/slice 視窗）。 */
  const clientToView = (
    clientX: number,
    clientY: number,
    rect: DOMRect,
    win: ViewWindow,
  ): [number, number] => [
    win.cx + ((clientX - rect.left) / rect.width) * win.vw,
    win.cy + ((clientY - rect.top) / rect.height) * win.vh,
  ];

  /** 兩指落下後建立捏合快照（初始距離、當時 transform、兩指中點）。 */
  const beginPinch = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const win = getViewWindow(rect, mobileRef.current);
    const [a, b] = pts;
    const [midViewX, midViewY] = clientToView(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      rect,
      win,
    );
    const { k, x, y } = transformRef.current;
    pinchRef.current = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      k0: k,
      x0: x,
      y0: y,
      midViewX,
      midViewY,
    };
    // 捏合期間不觸發拖曳，也視為已移動以抑制點選
    dragRef.current = null;
    movedRef.current = true;
  };

  /** 兩指移動時同步縮放與平移：保持起始中點下的世界座標點固定。 */
  const handlePinchMove = () => {
    const pinch = pinchRef.current;
    const svg = svgRef.current;
    if (!pinch || !svg || pinch.startDist === 0) return;
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const win = getViewWindow(rect, mobileRef.current);
    const [a, b] = pts;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const nk = Math.min(MAX_K, Math.max(MIN_K, pinch.k0 * (dist / pinch.startDist)));
    const [midViewX, midViewY] = clientToView(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      rect,
      win,
    );
    const wx = (pinch.midViewX - pinch.x0) / pinch.k0;
    const wy = (pinch.midViewY - pinch.y0) / pinch.k0;
    setTransform(clampTransform(nk, midViewX - wx * nk, midViewY - wy * nk, win));
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      // 進入捏合：釋放單指拖曳的捕獲，改用雙指縮放
      const svg = svgRef.current;
      const drag = dragRef.current;
      if (svg && drag?.captured) svg.releasePointerCapture(drag.pointerId);
      beginPinch();
      return;
    }
    const { x, y } = transformRef.current;
    movedRef.current = false;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: x,
      originY: y,
      captured: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const tracked = pointersRef.current.get(e.pointerId);
    if (tracked) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }
    if (pinchRef.current) {
      handlePinchMove();
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const win = getViewWindow(rect, mobileRef.current);
    const dx = ((e.clientX - drag.startX) / rect.width) * win.vw;
    const dy = ((e.clientY - drag.startY) / rect.height) * win.vh;
    if (!movedRef.current && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    movedRef.current = true;
    // 確認是真正的拖曳後才 capture，避免影響 click 事件的目標
    if (!drag.captured) {
      drag.captured = true;
      svg.setPointerCapture(e.pointerId);
    }
    const { k } = transformRef.current;
    setTransform(clampTransform(k, drag.originX + dx, drag.originY + dy, win));
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pinchRef.current) {
      // 少於兩指即結束捏合；若還剩一指，接續為拖曳避免畫面跳動
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        const remaining = [...pointersRef.current.entries()][0];
        if (remaining) {
          const [pointerId, pt] = remaining;
          const { x, y } = transformRef.current;
          dragRef.current = {
            pointerId,
            startX: pt.x,
            startY: pt.y,
            originX: x,
            originY: y,
            captured: false,
          };
        }
      }
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  };

  const { background, districts } = useMemo(() => {
    const bg: DistrictPath[] = [];
    const ds: DistrictPath[] = [];
    for (const p of paths ?? []) {
      (p.name === "" ? bg : ds).push(p);
    }
    return { background: bg, districts: ds };
  }, [paths]);

  /** 地區名稱 → 路徑（含中心點），供戰線箭頭查端點。 */
  const districtByName = useMemo(() => {
    const m = new Map<string, DistrictPath>();
    for (const d of districts) m.set(d.name, d);
    return m;
  }, [districts]);

  /** 城市點投影（viewBox 座標）；圖資載入後才有值。 */
  const cityPoints = useMemo(() => {
    const project = projectRef.current;
    if (!paths || !project || !cities || cities.length === 0) return [];
    const pts: {
      name: string;
      x: number;
      y: number;
      regionName: string;
      ownerNationName: string | null;
    }[] = [];
    for (const c of cities) {
      const p = project(c.lng, c.lat);
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      pts.push({
        name: c.name,
        x: p[0],
        y: p[1],
        regionName: c.regionName,
        ownerNationName: c.ownerNationName ?? null,
      });
    }
    return pts;
  }, [paths, cities]);

  /**
   * 城市名稱擁擠抑制：以螢幕座標（viewBox×k）貪婪放置標籤，
   * 與已放置標籤重疊者只畫點不畫名。隨縮放放大逐步顯示更多名稱。
   */
  const cityLabelVisible = useMemo(() => {
    const k = transform.k;
    const visible = new Set<string>();
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const c of cityPoints) {
      const sx = c.x * k;
      const sy = c.y * k;
      // 中文全形字寬 ≈ 字級；標籤畫在點右側
      const w = CITY_FONT * (c.name.length + 0.8);
      const h = CITY_FONT * 1.3;
      const box = { x0: sx, y0: sy - h / 2, x1: sx + w, y1: sy + h / 2 };
      const collides = placed.some(
        (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0,
      );
      if (!collides) {
        placed.push(box);
        visible.add(c.name);
      }
    }
    return visible;
  }, [cityPoints, transform.k]);

  if (loadError) {
    return (
      <div className="flex items-center gap-3 border border-dashed rounded-xl bg-destructive/5 text-destructive px-4 py-6">
        <AlertTriangle className="w-5 h-5 shrink-0" />
        <p className="text-sm">無法載入世界地圖圖資，請重新整理再試。</p>
      </div>
    );
  }

  if (!paths) {
    return (
      <Skeleton
        className={
          isMobile ? "w-full h-[70vh] rounded-xl" : "w-full aspect-[980/500] rounded-xl"
        }
      />
    );
  }

  const { k, x, y } = transform;
  const dataMode = fills != null;
  const wantValues = showValues && dataMode && valueByName != null;
  const showAnyLabel = showLabels || wantValues;

  return (
    <div
      className={`relative border border-border rounded-xl overflow-hidden bg-[hsl(var(--card))] ${
        isMobile ? "h-[70vh]" : ""
      }`}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio={isMobile ? "xMidYMid slice" : "xMidYMid meet"}
        className={`block touch-none select-none cursor-grab active:cursor-grabbing ${
          isMobile ? "w-full h-full" : "w-full h-auto"
        }`}
        role="img"
        aria-label="世界地圖"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={(e) => {
          endDrag(e);
          setHovered(null);
        }}
      >
        <g transform={`translate(${x},${y}) scale(${k})`}>
          {/* 未納入任何地區的陸地（灰色背景，不可點擊） */}
          {background.map((p, i) => (
            <path
              key={`bg-${i}`}
              d={p.d}
              className="fill-muted/60 stroke-border pointer-events-none"
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {districts.map((p) => {
            const isSelected = p.name === selectedName;
            const isNeighbor = neighborNames.has(p.name);
            const isHovered = p.name === hovered;

            if (dataMode) {
              // 數據視圖：色塊來自 fills，選取/鄰接以描邊呈現、不蓋掉色塊
              const fill = fills.get(p.name) ?? "hsl(var(--background))";
              return (
                <path
                  key={p.name}
                  d={p.d}
                  className="cursor-pointer"
                  style={{ fill }}
                  stroke={
                    isSelected
                      ? "hsl(var(--primary))"
                      : isNeighbor
                        ? "hsl(var(--primary) / 0.75)"
                        : isHovered
                          ? "hsl(var(--foreground) / 0.9)"
                          : "hsl(var(--foreground) / 0.35)"
                  }
                  strokeWidth={isSelected ? 2.4 : isNeighbor ? 1.6 : isHovered ? 1.2 : 0.55}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  onMouseEnter={() => setHovered(p.name)}
                  onMouseLeave={() =>
                    setHovered((prev) => (prev === p.name ? null : prev))
                  }
                  onClick={() => {
                    if (!movedRef.current) onSelect(p.name);
                  }}
                >
                  <title>{p.name}</title>
                </path>
              );
            }

            return (
              <path
                key={p.name}
                d={p.d}
                className={
                  isSelected
                    ? "fill-primary cursor-pointer"
                    : isNeighbor
                      ? "fill-primary/35 cursor-pointer"
                      : isHovered
                        ? "fill-primary/15 cursor-pointer"
                        : "fill-background cursor-pointer"
                }
                stroke="hsl(var(--foreground) / 0.45)"
                strokeWidth={isSelected ? 1.1 : 0.55}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => setHovered(p.name)}
                onMouseLeave={() =>
                  setHovered((prev) => (prev === p.name ? null : prev))
                }
                onClick={() => {
                  if (!movedRef.current) onSelect(p.name);
                }}
              >
                <title>{p.name}</title>
              </path>
            );
          })}

          {/* 地區標籤 / 數值（不攔截滑鼠事件；字級隨縮放反向縮放） */}
          {showAnyLabel && (
            <g className="pointer-events-none">
              {districts.map((p) => {
                // 擁擠抑制：螢幕上太小的地區不顯示標示
                if (p.area * k * k < LABEL_MIN_SCREEN_AREA) return null;
                const value = wantValues ? valueByName.get(p.name) : undefined;
                const hasName = showLabels;
                const hasValue = value !== undefined;
                if (!hasName && !hasValue) return null;
                const nameFont = LABEL_FONT / k;
                const valueFont = VALUE_FONT / k;
                return (
                  <text
                    key={`label-${p.name}`}
                    x={p.cx}
                    y={p.cy}
                    textAnchor="middle"
                    className="fill-foreground"
                    style={{
                      paintOrder: "stroke",
                      stroke: "hsl(var(--background) / 0.85)",
                      strokeWidth: 2.5 / k,
                      strokeLinejoin: "round",
                    }}
                    fontSize={nameFont}
                    fontWeight={600}
                  >
                    {hasName && (
                      <tspan x={p.cx} dy={hasValue ? -valueFont * 0.35 : nameFont * 0.35}>
                        {p.name}
                      </tspan>
                    )}
                    {hasValue && (
                      <tspan
                        x={p.cx}
                        dy={hasName ? nameFont * 1.1 : valueFont * 0.35}
                        fontSize={valueFont}
                        fontWeight={500}
                        className="fill-foreground/80"
                      >
                        {value}
                      </tspan>
                    )}
                  </text>
                );
              })}
            </g>
          )}

          {/* 政治視圖：主控國國旗＋國名（不攔截滑鼠事件；沿用擁擠抑制） */}
          {regionFlags && (
            <g className="pointer-events-none">
              {districts.map((p) => {
                if (p.area * k * k < LABEL_MIN_SCREEN_AREA) return null;
                const info = regionFlags.get(p.name);
                if (!info) return null;
                const nameFont = LABEL_FONT / k;
                const flagH = (LABEL_FONT * 0.85) / k;
                const flagW = flagH * 1.5;
                return (
                  <g key={`flag-${p.name}`}>
                    {info.flagUrl && (
                      <image
                        href={info.flagUrl}
                        x={p.cx - flagW / 2}
                        y={p.cy - flagH - nameFont * 0.15}
                        width={flagW}
                        height={flagH}
                        preserveAspectRatio="xMidYMid meet"
                        style={{
                          filter: "drop-shadow(0 0 1px hsl(var(--background)))",
                        }}
                      />
                    )}
                    <text
                      x={p.cx}
                      y={p.cy}
                      textAnchor="middle"
                      dy={info.flagUrl ? nameFont * 0.55 : nameFont * 0.35}
                      className="fill-foreground"
                      style={{
                        paintOrder: "stroke",
                        stroke: "hsl(var(--background) / 0.85)",
                        strokeWidth: 2.5 / k,
                        strokeLinejoin: "round",
                      }}
                      fontSize={nameFont}
                      fontWeight={600}
                    >
                      {info.label}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* 交戰地區紅色外框：遠看（箭頭太短）也能一眼看出哪裡在打。疊加層、不攔截滑鼠 */}
          {activeWarRegionNames && activeWarRegionNames.size > 0 && (
            <g className="pointer-events-none">
              {districts.map((p) =>
                activeWarRegionNames.has(p.name) ? (
                  <path
                    key={`warbox-${p.name}`}
                    d={p.d}
                    fill="rgba(220,38,38,0.18)"
                    stroke="#dc2626"
                    strokeWidth={1.8}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </g>
          )}

          {/* 戰線箭頭：攻方地區中心 → 守方地區中心（不攔截滑鼠；粗細與箭頭尺寸隨縮放反向縮放） */}
          {warFronts && warFronts.length > 0 && (
            <g className="pointer-events-none">
              {warFronts.map((f) => {
                const a = districtByName.get(f.attackerRegionName);
                const d = districtByName.get(f.defenderRegionName);
                if (!a || !d) return null;
                const geo = computeFrontPath(a.cx, a.cy, d.cx, d.cy, 9 / k, 12 / k);
                if (!geo) return null;
                // 遠程（弧線）戰線只有一條，標籤一律顯示；近距離需放大才顯示避免擠
                const showText = geo.curved || k >= 1.6;
                const fs = 11 / k;
                const text = warFrontLabel(f);
                return (
                  <g key={`front-${f.id}`}>
                    <path
                      d={geo.d}
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeDasharray={geo.curved ? "7 5" : undefined}
                      vectorEffect="non-scaling-stroke"
                      style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))" }}
                    />
                    <polygon
                      points={`${geo.headTipX},${geo.headTipY} ${geo.headLeftX},${geo.headLeftY} ${geo.headRightX},${geo.headRightY}`}
                      fill="#dc2626"
                      style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))" }}
                    />
                    {showText && (
                      <text
                        x={geo.midX}
                        y={geo.midY - 4 / k}
                        textAnchor="middle"
                        fontSize={fs}
                        fontWeight={700}
                        fill="#fff"
                        stroke="#7f1d1d"
                        strokeWidth={3 / k}
                        paintOrder="stroke"
                      >
                        {text}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          )}

          {/* 進行中戰役 ⚔ 標示（不攔截滑鼠事件；字級隨縮放反向縮放；無擁擠抑制，戰場必顯） */}
          {activeWarRegionNames && activeWarRegionNames.size > 0 && (
            <g className="pointer-events-none">
              {districts.map((p) => {
                if (!activeWarRegionNames.has(p.name)) return null;
                const fontSize = Math.max((LABEL_FONT * 1.3) / k, 5 / k);
                return (
                  <text
                    key={`war-${p.name}`}
                    x={p.cx}
                    y={p.cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={fontSize}
                    style={{
                      filter: "drop-shadow(0 0 2px rgba(0,0,0,0.65))",
                    }}
                  >
                    ⚔
                  </text>
                );
              })}
            </g>
          )}

          {/* 已選起始地區 ✓ 標示（不攔截滑鼠事件；字級隨縮放反向縮放；無擁擠抑制，必顯） */}
          {checkmarkRegionNames && checkmarkRegionNames.size > 0 && (
            <g className="pointer-events-none">
              {districts.map((p) => {
                if (!checkmarkRegionNames.has(p.name)) return null;
                const fontSize = Math.max((LABEL_FONT * 1.2) / k, 5 / k);
                return (
                  <text
                    key={`chk-${p.name}`}
                    x={p.cx}
                    y={p.cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={fontSize}
                    fontWeight={700}
                    style={{
                      fill: "#d97706",
                      filter: "drop-shadow(0 0 2px rgba(0,0,0,0.75))",
                    }}
                  >
                    ✓
                  </text>
                );
              })}
            </g>
          )}

          {/* 歷史城市點與名稱（不攔截滑鼠事件；大小隨縮放反向縮放） */}
          {showCities && cityPoints.length > 0 && (
            <g className="pointer-events-none">
              {cityPoints.map((c) => (
                <g key={`city-${c.name}`}>
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={CITY_DOT_R / k}
                    fill="#b91c1c"
                    stroke="hsl(var(--background))"
                    strokeWidth={0.9 / k}
                  />
                  {cityLabelVisible.has(c.name) && (
                    <text
                      x={c.x + (CITY_DOT_R + 1.6) / k}
                      y={c.y}
                      dominantBaseline="middle"
                      fontSize={CITY_FONT / k}
                      fontWeight={500}
                      className="fill-foreground/90"
                      style={{
                        paintOrder: "stroke",
                        stroke: "hsl(var(--background) / 0.85)",
                        strokeWidth: 2 / k,
                        strokeLinejoin: "round",
                      }}
                    >
                      <tspan x={c.x + (CITY_DOT_R + 1.6) / k}>{c.name}</tspan>
                      {c.ownerNationName && (
                        <tspan
                          x={c.x + (CITY_DOT_R + 1.6) / k}
                          dy={(CITY_FONT * 1.05) / k}
                          fontSize={(CITY_FONT * 0.82) / k}
                          fontWeight={400}
                          className="fill-foreground/65"
                        >
                          👑 {c.ownerNationName}
                        </tspan>
                      )}
                    </text>
                  )}
                </g>
              ))}
            </g>
          )}
        </g>
      </svg>

      {hovered && (
        <div className="absolute left-3 top-3 pointer-events-none bg-background/90 border border-border rounded-md px-2.5 py-1 text-sm font-medium shadow-sm">
          {hovered}
          {dataMode && valueByName?.get(hovered) !== undefined && (
            <span className="ml-2 text-muted-foreground tabular-nums">
              {valueByName.get(hovered)}
            </span>
          )}
        </div>
      )}

      {!legend && swatchLegend && !isMobile && (
        <div className="absolute left-3 bottom-3 bg-background/90 border border-border rounded-md px-3 py-2 shadow-sm max-w-[230px] max-h-[45%] overflow-y-auto">
          <div className="text-xs font-medium mb-1.5">{swatchLegend.title}</div>
          {swatchLegend.items.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">
              {swatchLegend.emptyText ?? "無資料"}
            </div>
          ) : (
            <ul className="space-y-1">
              {swatchLegend.items.map((item) => (
                <li key={item.label} className="flex items-center gap-1.5 text-[11px] leading-tight">
                  <span
                    className="inline-block w-3 h-3 rounded-sm border border-border/60 shrink-0"
                    style={{ background: item.color }}
                  />
                  <span className="truncate">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {legend && (
        <div className="absolute left-3 bottom-3 bg-background/90 border border-border rounded-md px-3 py-2 shadow-sm w-[190px]">
          <div className="text-xs font-medium mb-1.5">{legend.title}</div>
          <div
            className="h-2.5 rounded-sm border border-border/60"
            style={{
              background: `linear-gradient(to right, ${legend.from}, ${legend.to})`,
            }}
          />
          <div className="flex justify-between mt-1 text-[11px] text-muted-foreground tabular-nums">
            <span>{legend.minLabel}</span>
            <span>{legend.maxLabel}</span>
          </div>
        </div>
      )}

      <div className="absolute right-3 bottom-3 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => zoomBy(1.5)}
          className="bg-background/90 border border-border rounded-md p-1.5 text-foreground/80 hover:text-foreground hover:border-primary/50 shadow-sm"
          aria-label="放大"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.5)}
          className="bg-background/90 border border-border rounded-md p-1.5 text-foreground/80 hover:text-foreground hover:border-primary/50 shadow-sm"
          aria-label="縮小"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setTransform({ k: 1, x: 0, y: 0 })}
          className="bg-background/90 border border-border rounded-md p-1.5 text-foreground/80 hover:text-foreground hover:border-primary/50 shadow-sm"
          aria-label="重設視圖"
        >
          <Maximize className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
