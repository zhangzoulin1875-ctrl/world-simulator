import { Router, type IRouter, type Request, type Response } from "express";
import type { PlayerNation } from "@workspace/db";
import { requirePlayer } from "./war/shared";
import { MercenaryError, hasActiveMercenaryContract } from "../lib/mercenaryService";
import {
  getMobilizationState,
  isNationAtWar,
  startMobilization,
  stopMobilization,
} from "../lib/totalMobilizationService";
import {
  levyAmount,
  militiaStatsForEra,
  MOBILIZATION_POP_RATIO,
  MOBILIZATION_STABILITY_PER_TURN,
  MOBILIZATION_MIN_STABILITY_TO_START,
} from "../lib/totalMobilization";
import { computeNationStats, getEraSlugs } from "../lib/nationStats";

const router: IRouter = Router();

function wrap(fn: (nation: PlayerNation, req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requirePlayer(req, res);
    if (!auth) return;
    try {
      res.json((await fn(auth.nation, req)) ?? { ok: true });
    } catch (err) {
      if (err instanceof MercenaryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err, nationId: auth.nation.id }, "mobilization route failed");
      res.status(500).json({ error: "伺服器錯誤" });
    }
  };
}

/** 狀態與預覽:目前是否開啟、若現在開啟可徵召多少人、民兵數值、是否符合開啟條件。 */
router.get(
  "/player/mobilization",
  wrap(async (nation) => {
    const nationId = nation.id;
    const { statsEra } = await getEraSlugs();
    const state = await getMobilizationState(nationId);
    const stats = await computeNationStats(nationId, statsEra);
    const levy = levyAmount(stats.population, nation.populationSpent);
    const militia = militiaStatsForEra(statsEra);
    return {
      active: !!state?.active,
      lastLevy: state?.lastLevy ?? 0,
      startedAt: state?.startedAt ?? null,
      totalStabilityLost: state?.totalStabilityLost ?? 0,
      atWar: await isNationAtWar(nationId),
      hasMercenaryContract: await hasActiveMercenaryContract(nationId),
      stability: nation.stability,
      previewLevy: levy,
      popRatioPct: Math.round(MOBILIZATION_POP_RATIO * 100),
      stabilityPerTurn: MOBILIZATION_STABILITY_PER_TURN,
      minStabilityToStart: MOBILIZATION_MIN_STABILITY_TO_START,
      militia,
    };
  }),
);

router.post(
  "/player/mobilization/start",
  wrap(async (nation) => {
    const r = await startMobilization(nation.id);
    return { ok: true, ...r };
  }),
);

router.post(
  "/player/mobilization/stop",
  wrap(async (nation) => {
    const r = await stopMobilization(nation.id);
    return { ok: true, ...r };
  }),
);

export default router;
