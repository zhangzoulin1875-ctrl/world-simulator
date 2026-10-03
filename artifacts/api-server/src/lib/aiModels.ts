const DEFAULT_QUALITY_MODEL = "claude-haiku-4-5";
const DEFAULT_BULK_MODEL = "claude-haiku-4-5";

export type AiModelTier = "quality" | "bulk";

function envModel(key: string, fallback: string): string {
  const v = process.env[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

export function getAiModel(tier: AiModelTier): string {
  if (tier === "bulk") return envModel("AI_MODEL_BULK", DEFAULT_BULK_MODEL);
  return envModel("AI_MODEL_QUALITY", DEFAULT_QUALITY_MODEL);
}
