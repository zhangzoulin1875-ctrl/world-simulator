import { Router, type IRouter } from "express";
import { registerWarCampaignRoutes } from "./war/campaigns";
import { registerWarLegionRoutes } from "./war/legions";
import { registerWarOrderRoutes } from "./war/orders";
import { registerWarSupplyRoutes } from "./war/supply";
import { registerWarReportRoutes } from "./war/reports";
import { registerWarCeasefireRoutes } from "./war/ceasefire";
import { registerWarAdminRoutes } from "./war/admin";

const router: IRouter = Router();

registerWarCampaignRoutes(router);
registerWarLegionRoutes(router);
registerWarOrderRoutes(router);
registerWarSupplyRoutes(router);
registerWarReportRoutes(router);
registerWarCeasefireRoutes(router);
registerWarAdminRoutes(router);

export default router;
