// 開局部署(純函式):每方 N 支軍團,放在己方「前線區」(鄰接敵方或中立區),同區盡量不疊。
// 結果決定論:同樣的地圖永遠同樣的部署,方便測試與重播。
export const START = { armiesPerSide: 6, strength: 100, supply: 100 };

export function planDeployment(regions, perSide = START.armiesPerSide) {
  const by = new Map(regions.map((r) => [r.id, r]));
  const isCap = (r) => (r.tag || '').startsWith('capital');
  const out = [];
  for (const side of ['DE', 'FR']) {
    // 前線區:己方控制,且鄰接非己方區。後方區(rear)與首都不放,避免一開局就擠在邊上或空轉
    const front = regions
      .filter((r) => r.owner === side && !r.rear && !isCap(r) && r.adj.some((n) => by.get(n).owner !== side))
      .sort((a, b) => a.id - b.id);
    // 前線不夠時,補次前線(鄰接前線的己方區)
    const second = regions
      .filter((r) => r.owner === side && !r.rear && !isCap(r) && !front.includes(r) && r.adj.some((n) => front.some((f) => f.id === n)))
      .sort((a, b) => a.id - b.id);
    const pool = [...front, ...second];
    if (!pool.length) throw new Error(`找不到 ${side} 的部署區`);
    for (let i = 0; i < perSide; i++) {
      const r = pool[i % pool.length];
      out.push({ side, region: r.id, name: `${side === 'DE' ? '德軍第' : '法軍第'}${Math.floor(i) + 1}軍團`, strength: START.strength, supply: START.supply });
    }
  }
  return out;
}
