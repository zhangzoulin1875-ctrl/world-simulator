import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigCard, ActionPanel, RangeNotice } from "./game-oil";
import type { OilCampaignView, OilRigView, ShipView } from "@/lib/oilRigs";

const rig: OilRigView = { slug: "north_sea_1", name: "北海一號", sea: "北海", lng: 2, lat: 56, holder: { nationId: "D", name: "荷蘭國", color: "#f60" }, heldSince: null, anchorRegions: ["荷蘭", "東英格蘭"] };
const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
const camp: OilCampaignView = { id: 7, rigSlug: "north_sea_1", status: "active", startedAt: "", settleAt: future, outcome: null, attackerNationId: "A", defenderNationId: "D", attackerShips: 10, defenderShips: 0, attackerPower: 10000, defenderPower: 11500, forecast: "defender_wins" };
const ships: ShipView[] = [{ templateId: 1, name: "驅逐艦", owned: 12, committed: 2, woundedPool: 0, available: 10 }];
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);

test("RigCard:顯示名稱、持有者、無戰役時不顯示戰役列", () => {
  const html = wrap(<RigCard rig={rig} myNationId={null} active={false} onSelect={() => {}} />);
  assert.match(html, /北海一號/); assert.match(html, /荷蘭國/); assert.doesNotMatch(html, /戰役中/);
});
test("RigCard:無人佔領顯示「無人佔領」;有戰役顯示倒數", () => {
  const html = wrap(<RigCard rig={{ ...rig, holder: null }} campaign={camp} myNationId={null} active={false} onSelect={() => {}} />);
  assert.match(html, /無人佔領/); assert.match(html, /戰役中/); assert.match(html, /小時/);
});
test("RigCard:標示我的角色", () => {
  assert.match(wrap(<RigCard rig={rig} myNationId="D" active={false} onSelect={() => {}} />), /我持有/);
  assert.match(wrap(<RigCard rig={rig} campaign={camp} myNationId="A" active={false} onSelect={() => {}} />), /我進攻/);
  assert.match(wrap(<RigCard rig={rig} campaign={camp} myNationId="D" active={false} onSelect={() => {}} />), /我防守/);
});
test("ActionPanel:凍結時不顯示出兵表單,只顯示唯讀說明", () => {
  const html = wrap(<ActionPanel rig={rig} myNationId="X" frozen ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /賽季已結束,僅供查看/); assert.doesNotMatch(html, /oil-fleet-form|oil-submit/);
});
test("ActionPanel:攻方有戰役 → 顯示追加表單與雙方戰力、預測", () => {
  const html = wrap(<ActionPanel rig={rig} campaign={camp} myNationId="A" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /oil-fleet-form/); assert.match(html, /追加艦隊/); assert.match(html, /11,500/); assert.match(html, /守軍/); assert.match(html, /守方勝/);
  assert.match(html, /驅逐艦/); assert.match(html, /可派 10/);
});
test("ActionPanel:第三國遇到進行中的戰役 → 不能介入,沒有表單", () => {
  const html = wrap(<ActionPanel rig={rig} campaign={camp} myNationId="X" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /無法介入/); assert.doesNotMatch(html, /oil-submit/);
});
test("ActionPanel:持有者且無戰役 → 說明不能自攻,沒有表單", () => {
  const html = wrap(<ActionPanel rig={rig} myNationId="D" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /已持有這座油井/); assert.doesNotMatch(html, /oil-submit/);
});
test("ActionPanel:送出鈕初始為停用(沒輸入數量)", () => {
  const html = wrap(<ActionPanel rig={rig} campaign={camp} myNationId="A" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="oil-submit"|data-testid="oil-submit"[^>]*disabled=""/);
});
test("ActionPanel:沒有可派艦船 → 提示而不是空表單", () => {
  const html = wrap(<ActionPanel rig={rig} campaign={camp} myNationId="A" frozen={false} ships={[{ ...ships[0]!, available: 0 }]} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /沒有可派遣的艦船/);
});

test("RangeNotice:遠征顯示距離與戰力百分比,帶 tier", () => {
  const html = wrap(<RangeNotice elig={{ eligible: true, distanceKm: 7064, rangeFactor: 0.647 }} />);
  assert.match(html, /data-testid="oil-range-notice"/); assert.match(html, /data-tier="heavy"/);
  assert.match(html, /7,064/); assert.match(html, /65%/);
});
test("RangeNotice:近海與尚未載入時不渲染", () => {
  assert.equal(wrap(<RangeNotice elig={{ eligible: true, distanceKm: 615, rangeFactor: 0.969 }} />), "");
  assert.equal(wrap(<RangeNotice elig={undefined} />), "");
});
test("ActionPanel:進行中戰役的攻方折損顯示係數與距離", () => {
  const far = { ...camp, rangeFactor: 0.647, attackerDistances: [{ nationId: "A", km: 7064, factor: 0.647 }] };
  const html = wrap(<ActionPanel rig={rig} campaign={far} myNationId="A" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />);
  assert.match(html, /data-testid="oil-campaign-range"/); assert.match(html, /65%/); assert.match(html, /7,064/);
});
test("ActionPanel:無折扣或舊後端沒回 rangeFactor 時不顯示折損區塊", () => {
  const near = { ...camp, rangeFactor: 0.97 };
  assert.doesNotMatch(wrap(<ActionPanel rig={rig} campaign={near} myNationId="A" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />), /oil-campaign-range/);
  assert.doesNotMatch(wrap(<ActionPanel rig={rig} campaign={camp} myNationId="A" frozen={false} ships={ships} fleetLoading={false} onDone={async () => {}} />), /oil-campaign-range/);
});
