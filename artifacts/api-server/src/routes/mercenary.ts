import { Router, type IRouter, type Request, type Response } from "express";
import { requirePlayer } from "./war/shared";
import {
  MercenaryError,
  getMercenaryState,
  hasActiveCampaign,
  quoteCompanies,
  disarmNation,
  restoreArmy,
  signContract,
  terminateContract,
  deployMercenaries,
  recallMercenaries,
} from "../lib/mercenaryService";
import { getMercenaryCompany } from "../lib/mercenary";

const router: IRouter = Router();


/** 統一錯誤處理:MercenaryError → 對應狀態碼,其他 → 500。 */
function wrap(fn: (nationId: string, req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requirePlayer(req, res);
    if (!auth) return;
    try {
      const result = await fn(auth.nation.id, req);
      res.json(result ?? { ok: true });
    } catch (err) {
      if (err instanceof MercenaryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err, nationId: auth.nation.id }, "mercenary route failed");
      res.status(500).json({ error: "伺服器錯誤" });
    }
  };
}

/** 概況:是否解除武裝、目前合約、五間公司的即時報價(隨國力與時代動態調整)。 */
router.get(
  "/mercenary/overview",
  wrap(async (nationId) => {
    const state = await getMercenaryState(nationId);
    const quotes = await quoteCompanies(nationId);
    const active = state?.companyId ? getMercenaryCompany(state.companyId) : null;
    const activeQuote = active ? quotes.find((q) => q.company.id === active.id) ?? null : null;
    return {
      disarmed: !!state?.disarmed,
      hasActiveCampaign: await hasActiveCampaign(nationId),
      contract: active
        ? {
            companyId: active.id,
            name: active.name,
            signedAt: state!.signedAt,
            rentPerTurn: activeQuote?.rent ?? 0,
            deployFeePerTurn: activeQuote?.deployFee ?? 0,
            deployed: state!.deployedCampaignId
              ? {
                  campaignId: state!.deployedCampaignId,
                  slot: state!.deployedSlot,
                  mode: state!.deployedMode,
                }
              : null,
          }
        : null,
      lastTerminationNote: state?.lastTerminationNote ?? null,
      totals: {
        rentPaid: state?.totalRentPaid ?? 0,
        deployPaid: state?.totalDeployPaid ?? 0,
      },
      companies: quotes.map((q) => ({
        id: q.company.id,
        name: q.company.name,
        blurb: q.company.blurb,
        troops: q.force.troops,
        attack: q.force.attack,
        defense: q.force.defense,
        hp: q.force.hp,
        rentPerTurn: q.rent,
        deployFeePerTurn: q.deployFee,
        smallNationBoost: Number(q.force.boost.toFixed(2)),
      })),
    };
  }),
);

router.post("/mercenary/disarm", wrap((nationId) => disarmNation(nationId)));

router.post(
  "/mercenary/restore-army",
  wrap(async (nationId) => {
    await restoreArmy(nationId);
  }),
);

router.post(
  "/mercenary/sign",
  wrap(async (nationId, req) => {
    const companyId = (req.body as Record<string, unknown> | undefined)?.["companyId"];
    if (typeof companyId !== "string") throw new MercenaryError(400, "請選擇軍事公司");
    const s = await signContract(nationId, companyId);
    return { companyId: s.companyId, signedAt: s.signedAt };
  }),
);

router.post(
  "/mercenary/terminate",
  wrap(async (nationId) => {
    await terminateContract(nationId);
  }),
);

router.post(
  "/mercenary/deploy",
  wrap(async (nationId, req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const campaignId = Number(b["campaignId"]);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      throw new MercenaryError(400, "campaignId 不正確");
    }
    const s = await deployMercenaries({
      nationId,
      campaignId,
      slot: String(b["slot"] ?? ""),
      mode: b["mode"] as "defend" | "attack",
    });
    return { deployedCampaignId: s.deployedCampaignId, slot: s.deployedSlot, mode: s.deployedMode };
  }),
);

router.post(
  "/mercenary/recall",
  wrap(async (nationId) => {
    await recallMercenaries(nationId);
  }),
);

export default router;
