// 回合結算引擎:純函式,不碰資料庫、不用亂數(同樣輸入永遠同樣結果,方便測試與重播)。
//
// 狀態 state = {
//   turn,
//   regions: { [id]: { owner } },            // 'DE' | 'FR' | 'BE' | 'LU'
//   armies:  [{ id, side, name, region, strength, supply }],
//   belgiumInvaded: boolean,                 // 比利時是否已被入侵(法軍須等此旗標才能入比)
// }
// 命令 orders = [{ armyId, kind: 'move'|'attack'|'hold', target }]
// 結算順序:驗證命令 → 同時移動 → 戰鬥 → 佔領 → 補給 → 勝利判定。

export const RULES = {
  maxStrength: 100,
  defenderBonus: { fortress: 1.5, capital: 1.8, battlefield: 1.0, hub: 1.1, rear: 1.15, plain: 1.0 },
  // 傷亡:總損失 = 較小一方的兵力 × 此比例;依「戰力」分配給雙方(強者損失少)
  lossRate: 0.3,
  // 集中優勢:戰力 = 兵力^concentration(>1 讓集中兵力的收益大於分散)。僅用於比較勝負,不影響損失量級
  concentration: 1.15,
  // 補給:每回合恢復/衰減
  supplyMax: 100,
  supplyDecayPerHop: 12,       // 離補給源每遠一格,每回合 -12(上限內)
  supplyRecover: 25,           // 在補給範圍內每回合 +25
  lowSupplyThreshold: 40,      // 低於此值戰力打折
  minPower: 0.25,              // 補給歸零時戰力係數
  occupyNeeds: 1,              // 區內只剩我方軍團,且至少此兵力才佔領
  // 補給源:己方首都 + 己方控制的樞紐/要塞
  supplySourceTags: ['capital_de', 'capital_fr', 'hub', 'fortress'],
  neutral: ['BE', 'LU'],
  // 控制區(ZOC):進入「鄰接敵軍」的區之後,該軍團下個回合不能再移動(必須先停下整頓)。擋住繞行直奔首都。
  zocPinsTurns: 1,
  // 首都與要塞的常駐守備:即使區內沒有軍團,攻方也要先打掉這份守備才能佔領
  garrison: { capital: 300, fortress: 80 },
};

const other = (s) => (s === 'DE' ? 'FR' : 'DE');

export function buildMap(regions) {
  const by = new Map(regions.map((r) => [r.id, r]));
  const capital = {
    DE: regions.find((r) => r.tag === 'capital_de')?.id,
    FR: regions.find((r) => r.tag === 'capital_fr')?.id,
  };
  return { by, capital, regions };
}

/** 地形類別(決定防守加成) */
export function terrain(map, id) {
  const r = map.by.get(id);
  if (!r) return 'plain';
  if (r.tag === 'capital_de' || r.tag === 'capital_fr') return 'capital';
  if (r.tag === 'fortress') return 'fortress';
  if (r.tag === 'hub') return 'hub';
  if (r.tag === 'battlefield') return 'battlefield';
  if (r.rear) return 'rear';
  return 'plain';
}

/** 戰力 = 兵力 × 補給係數。補給 ≥ 門檻為 1,之後線性降到 minPower */
export function powerOf(army) {
  const t = RULES.lowSupplyThreshold;
  const k = army.supply >= t ? 1 : RULES.minPower + (1 - RULES.minPower) * (Math.max(army.supply, 0) / t);
  return army.strength * k;
}

/** 這個區對某方能否進入:中立比利時/盧森堡,法軍須等德軍入侵後;德軍可隨時進(會觸發入侵旗標) */
export function canEnter(state, map, side, regionId) {
  const owner = state.regions[regionId]?.owner;
  if (!owner) return false;
  if (RULES.neutral.includes(owner) && side === 'FR' && !state.belgiumInvaded) return false;
  return true;
}

/** 驗證單一命令,回傳 { ok, reason } */
export function validateOrder(state, map, army, order) {
  if (!army) return { ok: false, reason: '找不到軍團' };
  if (order.kind === 'hold') return { ok: true };
  if ((army.pinned ?? 0) > 0) return { ok: false, reason: '剛進入敵軍控制區,本回合必須整頓' };
  if (order.kind !== 'move' && order.kind !== 'attack') return { ok: false, reason: '未知命令' };
  const here = map.by.get(army.region);
  if (!here?.adj.includes(order.target)) return { ok: false, reason: '目標不相鄰' };
  if (!canEnter(state, map, army.side, order.target)) return { ok: false, reason: '比利時中立:德軍入侵前法軍不得進入' };
  return { ok: true };
}

/** 開局守備:每個首都/要塞區依所屬方獲得常駐守備 */
export function initialGarrisons(map, regions) {
  const g = {};
  for (const r of map.regions) {
    const t = terrain(map, r.id);
    if (RULES.garrison[t]) g[r.id] = RULES.garrison[t];
  }
  return g;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 計算每個軍團到最近己方補給源的格數(只走己方控制或空的區;敵控區不通) */
export function supplyDistances(state, map, side) {
  const sources = map.regions.filter(
    (r) => RULES.supplySourceTags.includes(r.tag) && state.regions[r.id]?.owner === side &&
      // 首都只算本方的
      !(r.tag === 'capital_de' && side !== 'DE') && !(r.tag === 'capital_fr' && side !== 'FR'));
  const dist = new Map();
  const q = [];
  for (const s of sources) { dist.set(s.id, 0); q.push(s.id); }
  while (q.length) {
    const x = q.shift();
    for (const y of map.by.get(x).adj) {
      if (dist.has(y)) continue;
      const o = state.regions[y]?.owner;
      if (o === other(side)) continue;          // 敵控區切斷補給線
      dist.set(y, dist.get(x) + 1);
      q.push(y);
    }
  }
  return dist;
}

/** 區的常駐守備戰力(只在該區仍屬原擁有者時有效;守備值存在 state.garrisons,被打光才歸零) */
export function garrisonOf(state, map, regionId) {
  const g = state.garrisons?.[regionId];
  return g ?? 0;
}

/** 單一區的戰鬥:攻方(進入者)對守方(原駐軍)。回傳雙方損失與勝負 */
export function resolveBattle(map, regionId, attackers, defenders, garrison = 0) {
  const aPow = attackers.reduce((s, a) => s + powerOf(a), 0);
  const bonus = RULES.defenderBonus[terrain(map, regionId)] ?? 1;
  const dPow = (defenders.reduce((s, a) => s + powerOf(a), 0) + garrison) * bonus;
  const smaller = Math.min(aPow, dPow);
  const total = smaller * RULES.lossRate * 2;
  const k = RULES.concentration;
  const aEff = Math.pow(aPow, k), dEff = Math.pow(dPow, k);
  // 損失依對方戰力比例分配:強者損失少
  const aLoss = total * (dEff / (aEff + dEff));
  const dLoss = total * (aEff / (aEff + dEff));
  return { aPow, dPow, aLoss, dLoss, attackerWins: aEff > dEff };
}

/** 把損失按兵力比例分給一組軍團(整數、不為負) */
function applyLoss(group, loss) {
  const sum = group.reduce((s, a) => s + a.strength, 0) || 1;
  for (const a of group) a.strength = Math.max(0, Math.round(a.strength - loss * (a.strength / sum)));
}

/**
 * 結算一個回合。回傳 { state, log, winner }。不修改傳入的 state。
 * 同一回合內:所有移動「同時」生效;兩支對向互換位置的軍團視為在邊界相遇(都不動並交戰於守方區)。
 */
export function resolveTurn(stateIn, map, orders) {
  const state = clone(stateIn);
  const log = [];
  const armies = state.armies.filter((a) => a.strength > 0);
  const byId = new Map(armies.map((a) => [a.id, a]));

  // 1. 驗證命令。每個軍團只吃一條(最後一條);無效命令記錄後視為 hold
  const intent = new Map();
  for (const o of orders) {
    const a = byId.get(o.armyId);
    const v = validateOrder(state, map, a, o);
    if (!v.ok) { if (a) log.push(`${a.name}:命令無效(${v.reason}),原地待命`); continue; }
    if (o.kind !== 'hold') intent.set(a.id, o.target);
  }

  // 2. 移動 → 決定每個軍團的目的區。目的區有敵軍(含對向移動中)就是攻擊
  const dest = new Map(armies.map((a) => [a.id, intent.get(a.id) ?? a.region]));
  const startAt = (id) => armies.filter((a) => a.region === id);

  // 對向互換:A→B 且 B→A。不能擦肩而過:改成兩軍都定在「雙方邊界的其中一區」交戰。
  // 交戰地點 = 該對中「區域擁有者所屬陣營」的軍團所在區(守方主場);都不是則取編號較小者。
  const handled = new Set();
  for (const a of armies) {
    const t = dest.get(a.id);
    if (t === a.region || handled.has(a.id)) continue;
    for (const b of armies) {
      if (b.side === a.side || handled.has(b.id) || b.region !== t || dest.get(b.id) !== a.region) continue;
      const aHome = state.regions[a.region]?.owner === a.side, bHome = state.regions[b.region]?.owner === b.side;
      const site = aHome && !bHome ? a.region : bHome && !aHome ? b.region : Math.min(a.region, b.region);
      dest.set(a.id, site); dest.set(b.id, site);
      handled.add(a.id); handled.add(b.id);
    }
  }

  // 3. 戰鬥:逐區處理。區內「己方(原地不動)」vs「敵方(進入者)」
  const regionIds = new Set([...armies.map((a) => dest.get(a.id))]);
  const retreatTo = new Map();
  for (const rid of [...regionIds].sort((a, b) => a - b)) {
    const present = armies.filter((a) => dest.get(a.id) === rid);
    const sides = new Set(present.map((a) => a.side));
    if (sides.size < 2) continue;
    // 守方 = 該區目前擁有者(或原本就在區內的一方);另一方為攻方
    const owner = state.regions[rid]?.owner;
    const defSide = sides.has(owner) ? owner : [...sides].find((s) => startAt(rid).some((a) => a.side === s)) ?? 'DE';
    const defenders = present.filter((a) => a.side === defSide);
    const attackers = present.filter((a) => a.side !== defSide);
    const garrison = state.garrisons?.[rid] && state.regions[rid]?.owner === defSide ? state.garrisons[rid] : 0;
    const r = resolveBattle(map, rid, attackers, defenders, garrison);
    applyLoss(attackers, r.aLoss);
    // 守方損失先扣常駐守備,再扣野戰軍團
    let dl = r.dLoss;
    if (garrison > 0) { const used = Math.min(garrison, dl); state.garrisons[rid] = garrison - used; dl -= used; }
    applyLoss(defenders, dl);
    log.push(`${map.by.get(rid).name ?? '區' + rid}會戰:攻 ${Math.round(r.aPow)} vs 守 ${Math.round(r.dPow)},攻方損失 ${Math.round(r.aLoss)}、守方損失 ${Math.round(r.dLoss)}${r.attackerWins ? ',守軍潰退' : ',攻勢受挫'}`);
    // 敗者撤退:攻方敗 → 回原區;守方敗 → 撤到己方相鄰區(沒有則全滅)
    const loser = r.attackerWins ? defenders : attackers;
    for (const a of loser) {
      if (a.strength <= 0) continue;
      if (loser === attackers) { dest.set(a.id, a.region); continue; }
      const back = map.by.get(rid).adj.find((n) => state.regions[n]?.owner === a.side && !armies.some((x) => x.side !== a.side && dest.get(x.id) === n));
      if (back !== undefined) dest.set(a.id, back); else a.strength = 0;
    }
  }

  // 4. 落地:存活者移到目的區
  for (const a of armies) { if (a.strength > 0) a.region = dest.get(a.id); }
  state.armies = armies.filter((a) => a.strength > 0);

  // 4b. 控制區:舊的釘住先遞減(本回合已被擋過一次移動),再對「本回合移動進入敵軍鄰區」的軍團重新釘住
  const startRegion = new Map(stateIn.armies.map((a) => [a.id, a.region]));
  for (const a of state.armies) {
    a.pinned = Math.max(0, (a.pinned ?? 0) - 1);
    if (startRegion.get(a.id) === a.region) continue;           // 沒移動
    const nearEnemy = map.by.get(a.region).adj.some((n) => state.armies.some((x) => x.side !== a.side && x.region === n));
    if (nearEnemy) a.pinned = RULES.zocPinsTurns;
  }

  // 5. 比利時入侵旗標:德軍進入比利時/盧森堡區
  for (const a of state.armies) {
    if (a.side === 'DE' && RULES.neutral.includes(state.regions[a.region]?.owner) && !state.belgiumInvaded) {
      state.belgiumInvaded = true; log.push('德軍越過邊界入侵比利時!法軍現在可以進入比利時。');
    }
  }

  // 6. 佔領:區內只剩單一陣營且兵力足夠 → 變為該陣營控制(比利時區被佔領也換手)
  for (const rid of Object.keys(state.regions).map(Number)) {
    const here = state.armies.filter((a) => a.region === rid);
    const sides = new Set(here.map((a) => a.side));
    if (sides.size !== 1) continue;
    const side = [...sides][0];
    const total = here.reduce((s, a) => s + a.strength, 0);
    const owner = state.regions[rid].owner;
    if (owner === side || total < RULES.occupyNeeds) continue;
    if (RULES.neutral.includes(owner) && side === 'FR' && !state.belgiumInvaded) continue;
    if ((state.garrisons?.[rid] ?? 0) > 0) continue;       // 守備未被打光:不能佔領
    state.regions[rid].owner = side;
    if (state.garrisons) delete state.garrisons[rid];
    log.push(`${side === 'DE' ? '德軍' : '法軍'}佔領${map.by.get(rid).name ?? '區' + rid}`);
  }

  // 7. 補給:依到己方補給源的距離
  for (const side of ['DE', 'FR']) {
    const dist = supplyDistances(state, map, side);
    for (const a of state.armies.filter((x) => x.side === side)) {
      const d = dist.get(a.region);
      if (d === undefined) a.supply = Math.max(0, a.supply - 30);            // 被切斷
      else if (d <= 2) a.supply = Math.min(RULES.supplyMax, a.supply + RULES.supplyRecover);
      else a.supply = Math.max(0, a.supply - (d - 2) * RULES.supplyDecayPerHop);
    }
  }

  // 8. 勝利:佔領敵方首都
  let winner = null;
  for (const side of ['DE', 'FR']) {
    if (state.regions[map.capital[other(side)]]?.owner === side) winner = side;
  }
  if (winner) log.push(`${winner === 'DE' ? '德國' : '法國'}佔領敵方首都,取得勝利!`);

  state.turn += 1;
  return { state, log, winner };
}
