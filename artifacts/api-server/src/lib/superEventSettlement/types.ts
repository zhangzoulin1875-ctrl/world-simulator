export interface SuperEventSettlementSummary {
  generated: number;
  eventsProcessed: number;
  eventsEnded: number;
  eventsFailedAi: number;
  responsesJudged: number;
  responsesFailedAi: number;
  techGranted: number;
}

export interface AffectedNation {
  id: string;
  name: string | null;
  government: string | null;
  discordUserId: string | null;
  isNpc: boolean;
  /** 受本事件影響、且該國掌控的地區 id。 */
  scopedRegionIds: number[];
  /** 受影響地區的加權人口基準（statsEra）。 */
  scopedPopBase: number;
  /** 受影響地區的加權生產力基準（statsEra）。 */
  scopedProdBase: number;
  /** 該國全部地區的加權人口基準（statsEra）——用於計算暴露比例。 */
  totalPopBase: number;
}

/** 某回合對單一國家實際套用（夾限後）的整數變動。 */
export interface AppliedDeltas {
  populationDelta: number;
  productionDelta: number;
  satisfactionFarmersDelta: number;
  satisfactionWorkersDelta: number;
  satisfactionNoblesDelta: number;
  satisfactionClergyDelta: number;
  stabilityDelta: number;
  unrestDelta: number;
}

export const ZERO_DELTAS = (): AppliedDeltas => ({
  populationDelta: 0,
  productionDelta: 0,
  satisfactionFarmersDelta: 0,
  satisfactionWorkersDelta: 0,
  satisfactionNoblesDelta: 0,
  satisfactionClergyDelta: 0,
  stabilityDelta: 0,
  unrestDelta: 0,
});

export function addDeltas(a: AppliedDeltas, b: AppliedDeltas): AppliedDeltas {
  return {
    populationDelta: a.populationDelta + b.populationDelta,
    productionDelta: a.productionDelta + b.productionDelta,
    satisfactionFarmersDelta:
      a.satisfactionFarmersDelta + b.satisfactionFarmersDelta,
    satisfactionWorkersDelta:
      a.satisfactionWorkersDelta + b.satisfactionWorkersDelta,
    satisfactionNoblesDelta:
      a.satisfactionNoblesDelta + b.satisfactionNoblesDelta,
    satisfactionClergyDelta:
      a.satisfactionClergyDelta + b.satisfactionClergyDelta,
    stabilityDelta: a.stabilityDelta + b.stabilityDelta,
    unrestDelta: a.unrestDelta + b.unrestDelta,
  };
}
