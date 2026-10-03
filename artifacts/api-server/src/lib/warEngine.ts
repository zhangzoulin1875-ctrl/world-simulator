export {
  NPC_INITIATE_COOLDOWN_HOURS,
  flushWarBackgroundWork,
  WarActionError,
} from "./warEngine/shared";
export {
  getNavalLandingProfile,
  getWoundedStatus,
} from "./warEngine/status";
export type { NavalLandingProfile } from "./warEngine/status";
export { initiateCampaign } from "./warEngine/initiate";
export {
  settleDueCampaigns,
  settleAllActiveCampaigns,
  applyGlobalWarCycleHours,
  settleCampaign,
} from "./warEngine/settle";
export type { SettleResult } from "./warEngine/settle";
export {
  endCampaignsForWar,
  forceEndCampaign,
  endCampaignsForNation,
} from "./warEngine/endCampaign";
export type { CampaignEndReason } from "./warEngine/endCampaign";
export { recoveryTick } from "./warEngine/recovery";
export { npcWarTick } from "./warEngine/npc";
export { startWarEngineLoops } from "./warEngine/loops";
